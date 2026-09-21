import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Diffusion à une audience — `sendPushToUsers`.
 *
 * ## Ce que remplaçait cette méthode
 *
 * `MenusListener` bouclait sur **tous** les clients ayant déjà commandé chez un
 * vendeur, avec un `await sendPushNotification(...)` par client. Chaque tour
 * coûtait une requête `FcmToken.findMany` **et** un aller-retour FCM, en série,
 * dans le processus web. Aucune borne, aucun lot, aucune déduplication : un
 * vendeur publiant vingt menus déclenchait vingt rafales séquentielles.
 *
 * FCM expose `sendEachForMulticast`, qui accepte **500 jetons par appel**. Mille
 * destinataires passent donc de mille allers-retours à deux — et les jetons
 * sont lus en une seule requête au lieu de mille.
 *
 * ## Ce que ces tests figent
 *
 * La borne, le découpage en lots, le nettoyage des jetons périmés, et le fait
 * qu'une audience vide ne déclenche **aucun** appel réseau.
 */
describe('NotificationsService.sendPushToUsers', () => {
  const makeService = (tokens: { token: string; userId: string }[]) => {
    const sendEachForMulticast = jest
      .fn()
      .mockImplementation(async ({ tokens: batch }: { tokens: string[] }) => ({
        successCount: batch.length,
        failureCount: 0,
        responses: batch.map(() => ({ success: true })),
      }));
    const prisma = {
      fcmToken: {
        findMany: jest.fn().mockResolvedValue(tokens),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const firebase = {
      isReady: () => true,
      getMessaging: () => ({ sendEachForMulticast }),
    };
    const service = new NotificationsService(
      prisma as unknown as PrismaService,
      firebase as unknown as FirebaseService,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, prisma, sendEachForMulticast };
  };

  const manyTokens = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      token: `tok-${i}`,
      userId: `u-${i}`,
    }));

  it('lit les jetons en UNE requête, pas une par destinataire', async () => {
    const { service, prisma } = makeService(manyTokens(3));

    await service.sendPushToUsers(['u-0', 'u-1', 'u-2'], 'Titre', 'Corps');

    expect(prisma.fcmToken.findMany).toHaveBeenCalledTimes(1);
  });

  it('découpe en lots de 500 jetons', async () => {
    // 1200 jetons ⇒ 3 appels (500 + 500 + 200), pas 1200.
    const { service, sendEachForMulticast } = makeService(manyTokens(1200));

    await service.sendPushToUsers(
      manyTokens(1200).map((t) => t.userId),
      'Titre',
      'Corps',
    );

    expect(sendEachForMulticast).toHaveBeenCalledTimes(3);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toHaveLength(500);
    expect(sendEachForMulticast.mock.calls[2][0].tokens).toHaveLength(200);
  });

  it('ne fait AUCUN appel réseau sur une audience vide', async () => {
    const { service, sendEachForMulticast, prisma } = makeService([]);

    await service.sendPushToUsers([], 'Titre', 'Corps');

    expect(prisma.fcmToken.findMany).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('supprime les jetons que FCM déclare périmés', async () => {
    const { service, prisma } = makeService(manyTokens(2));
    const messaging = {
      sendEachForMulticast: jest.fn().mockResolvedValue({
        successCount: 1,
        failureCount: 1,
        responses: [
          { success: true },
          {
            success: false,
            error: { code: 'messaging/registration-token-not-registered' },
          },
        ],
      }),
    };
    (
      service['firebase'] as unknown as { getMessaging: () => unknown }
    ).getMessaging = () => messaging;

    await service.sendPushToUsers(['u-0', 'u-1'], 'Titre', 'Corps');

    expect(prisma.fcmToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['tok-1'] } },
    });
  });

  it('rend le compte des envois réussis', async () => {
    const { service } = makeService(manyTokens(4));

    await expect(
      service.sendPushToUsers(['u-0', 'u-1', 'u-2', 'u-3'], 'T', 'C'),
    ).resolves.toEqual({ sent: 4, failed: 0, devices: 4 });
  });
});
