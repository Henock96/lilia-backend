import { NotificationsService, pushChannelFor } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Canal Android d'un push (sonnerie vendeur, Phase 3 F3-01).
 *
 * Une commande payée à accepter part sur `new_orders_channel`, que l'app
 * vendeur crée avec un carillon dédié : c'est ce canal qui sonne quand l'app
 * est en arrière-plan. Tout le reste garde le canal historique. Une app
 * vendeur antérieure, qui n'a pas créé ce canal, retombe sur le canal par
 * défaut d'Android : rien ne casse.
 */
describe('pushChannelFor', () => {
  it('nouvelle commande : canal et carillon dédiés', () => {
    expect(pushChannelFor({ type: 'new_order', orderId: 'o1' })).toEqual({
      channelId: 'new_orders_channel',
      sound: 'new_order',
    });
  });

  it.each([
    [undefined],
    [{}],
    [{ type: 'order_update' }],
    [{ type: 'incident' }],
  ])('tout le reste : canal historique, son par défaut (%j)', (data) => {
    expect(pushChannelFor(data)).toEqual({
      channelId: 'high_importance_channel',
      sound: 'default',
    });
  });
});

describe('NotificationsService.sendPushNotification — canal appliqué', () => {
  it('le message envoyé porte le canal de son type', async () => {
    const send = jest.fn().mockResolvedValue('msg-1');
    const service = new NotificationsService(
      {
        fcmToken: {
          findMany: jest.fn().mockResolvedValue([{ token: 't1' }]),
          deleteMany: jest.fn(),
        },
      } as unknown as PrismaService,
      {
        isReady: () => true,
        getMessaging: () => ({ send }),
      } as unknown as FirebaseService,
    );

    await service.sendPushNotification('u1', 'Titre', 'Corps', {
      type: 'new_order',
      orderId: 'o1',
    });

    expect(send.mock.calls[0][0].android.notification).toEqual({
      channelId: 'new_orders_channel',
      sound: 'new_order',
    });
  });
});
