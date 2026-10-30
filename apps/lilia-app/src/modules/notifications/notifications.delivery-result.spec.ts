import { NotificationsService, pushWasAccepted } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Résultat d'un envoi unitaire (audit du 28/10/2026, F-01).
 *
 * `sendPushNotification` rendait `void` et ne levait jamais : ses appelants
 * prenaient sa résolution pour un succès, y compris quand rien n'était parti.
 * Ces tests figent ce que le résultat doit dire dans chaque cas.
 */
describe('NotificationsService.sendPushNotification — résultat', () => {
  const build = (opts: {
    ready?: boolean;
    tokens?: string[];
    send?: jest.Mock;
  }) => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const service = new NotificationsService(
      {
        fcmToken: {
          findMany: jest
            .fn()
            .mockResolvedValue((opts.tokens ?? []).map((token) => ({ token }))),
          deleteMany,
        },
      } as unknown as PrismaService,
      {
        isReady: () => opts.ready ?? true,
        getMessaging: () => ({ send: opts.send ?? jest.fn() }),
      } as unknown as FirebaseService,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    return { service, deleteMany };
  };

  it('Firebase non initialisé : rien d’accepté, motif explicite', async () => {
    const { service } = build({ ready: false, tokens: ['t1'] });
    const result = await service.sendPushNotification('u1', 'T', 'B');
    expect(result).toEqual({
      accepted: 0,
      failed: 0,
      devices: 0,
      reason: 'FIREBASE_NOT_READY',
    });
    expect(pushWasAccepted(result)).toBe(false);
  });

  it('aucun token : rien d’accepté, motif explicite', async () => {
    const { service } = build({ tokens: [] });
    const result = await service.sendPushNotification('u1', 'T', 'B');
    expect(result.reason).toBe('NO_TOKEN');
    expect(pushWasAccepted(result)).toBe(false);
  });

  it('tous les envois refusés : ALL_FAILED, tokens périmés nettoyés', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce({
        code: 'messaging/registration-token-not-registered',
      })
      .mockRejectedValueOnce({
        code: 'messaging/internal-error',
        message: 'x',
      });
    const { service, deleteMany } = build({ tokens: ['t1', 't2'], send });

    const result = await service.sendPushNotification('u1', 'T', 'B');

    expect(result).toEqual({
      accepted: 0,
      failed: 2,
      devices: 2,
      reason: 'ALL_FAILED',
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['t1'] } },
    });
  });

  it('envoi partiel : accepté, sans motif d’échec', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce('msg-1')
      .mockRejectedValueOnce({
        code: 'messaging/internal-error',
        message: 'x',
      });
    const { service } = build({ tokens: ['t1', 't2'], send });

    const result = await service.sendPushNotification('u1', 'T', 'B');

    expect(result).toEqual({ accepted: 1, failed: 1, devices: 2 });
    expect(pushWasAccepted(result)).toBe(true);
  });

  it('pushWasAccepted tolère un résultat absent (appel qui a levé)', () => {
    expect(pushWasAccepted(undefined)).toBe(false);
  });
});
