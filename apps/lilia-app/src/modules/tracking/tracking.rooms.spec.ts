import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';

import { TrackingGateway } from './tracking.gateway';
import { TrackingService } from './tracking.service';
import { FirebaseService } from '../firebase/firebase.service';
import { UserCacheService } from '../auth/services/user-cache.service';

/**
 * Appartenance aux rooms de suivi.
 *
 * Défaut relevé le 22/09/2026 :
 *
 * · **WS-001** — `lilia-food-admin` émet `order:unwatch` à la fermeture d'un
 *   écran de suivi (trois sites d'appel). Aucun `@SubscribeMessage` ne
 *   l'écoutait : l'émission était un no-op silencieux, la socket ne quittait
 *   jamais la room, et les positions continuaient d'être routées — entre
 *   instances, via l'adapter Redis — vers des écrans qui ne les affichent plus.

 */
describe('TrackingGateway — appartenance aux rooms', () => {
  let gateway: TrackingGateway;

  const tracking = {
    assertCanWatchOrder: jest.fn(),
    assertCanUpdatePosition: jest.fn(),
    updatePosition: jest.fn(),
    calculateETA: jest.fn().mockResolvedValue(7),
    getLastPosition: jest.fn().mockResolvedValue(null),
  };
  const userCache = { getByFirebaseUid: jest.fn() };

  const makeClient = (data: Record<string, unknown>) => ({
    data,
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  });

  const inOneHour = Math.floor(Date.now() / 1000) + 3600;

  beforeEach(async () => {
    jest.clearAllMocks();
    tracking.assertCanWatchOrder.mockResolvedValue(undefined);
    userCache.getByFirebaseUid.mockResolvedValue({
      id: 'u1',
      statusUser: 'ACTIVE',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingGateway,
        { provide: TrackingService, useValue: tracking },
        { provide: FirebaseService, useValue: { getAuth: jest.fn() } },
        { provide: UserCacheService, useValue: userCache },
      ],
    }).compile();

    gateway = module.get<TrackingGateway>(TrackingGateway);
  });

  describe('order:unwatch', () => {
    it('fait réellement quitter la room', async () => {
      const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });

      await gateway.onUnwatchOrder(client as never, { orderId: 'o1' });

      expect(client.leave).toHaveBeenCalledWith('order:o1');
    });

    it('ne demande aucune autorisation pour partir', async () => {
      const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });
      tracking.assertCanWatchOrder.mockRejectedValue(new ForbiddenException());

      // Quitter une room n'expose rien. Exiger un droit ici enfermerait dans la
      // room précisément celui qui vient de le perdre.
      await expect(
        gateway.onUnwatchOrder(client as never, { orderId: 'o1' }),
      ).resolves.toBeUndefined();
      expect(client.leave).toHaveBeenCalledWith('order:o1');
    });
  });
});
