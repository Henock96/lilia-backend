import { Test, TestingModule } from '@nestjs/testing';
import { WsException } from '@nestjs/websockets';
import { TrackingGateway } from './tracking.gateway';
import { TrackingService } from './tracking.service';
import { FirebaseService } from '../firebase/firebase.service';
import { UserCacheService } from '../auth/services/user-cache.service';

/**
 * Smoke test DI TrackingGateway (LIL-106) + revalidation de session (audit
 * 2026-08-01, M-7) : le token n'était vérifié qu'à la connexion, laissant une
 * socket ouverte survivre à l'expiration du token et au bannissement du compte.
 */
describe('TrackingGateway', () => {
  let gateway: TrackingGateway;

  const tracking = {
    assertCanWatchOrder: jest.fn(),
    getLastPosition: jest.fn().mockResolvedValue(null),
  };
  const userCache = { getByFirebaseUid: jest.fn() };

  /** Socket minimale : ce que la gateway lit et appelle réellement. */
  const makeClient = (data: Record<string, unknown>) => ({
    data,
    join: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  });

  const inOneHour = Math.floor(Date.now() / 1000) + 3600;
  const anHourAgo = Math.floor(Date.now() / 1000) - 3600;

  beforeEach(async () => {
    jest.clearAllMocks();
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

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  it('token encore valide + compte actif → la commande est bien rejointe', async () => {
    const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });

    await gateway.onWatchOrder(client as any, { orderId: 'o1' });

    expect(tracking.assertCanWatchOrder).toHaveBeenCalledWith('o1', 'fb1');
    expect(client.join).toHaveBeenCalledWith('order:o1');
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('token expiré → déconnexion, aucune donnée servie', async () => {
    const client = makeClient({ uid: 'fb1', tokenExp: anHourAgo });

    await expect(
      gateway.onWatchOrder(client as any, { orderId: 'o1' }),
    ).rejects.toBeInstanceOf(WsException);

    expect(client.disconnect).toHaveBeenCalled();
    expect(tracking.assertCanWatchOrder).not.toHaveBeenCalled();
  });

  it('compte passé BLOCKED pendant la session → déconnexion', async () => {
    userCache.getByFirebaseUid.mockResolvedValue({
      id: 'u1',
      statusUser: 'BLOCKED',
    });
    const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });

    await expect(
      gateway.onWatchOrder(client as any, { orderId: 'o1' }),
    ).rejects.toBeInstanceOf(WsException);

    expect(client.disconnect).toHaveBeenCalled();
    expect(tracking.assertCanWatchOrder).not.toHaveBeenCalled();
  });

  it('handleConnection mémorise `exp` pour permettre la revalidation', async () => {
    const verifyIdToken = jest
      .fn()
      .mockResolvedValue({ uid: 'fb1', exp: inOneHour });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingGateway,
        { provide: TrackingService, useValue: tracking },
        {
          provide: FirebaseService,
          useValue: { getAuth: () => ({ verifyIdToken }) },
        },
        { provide: UserCacheService, useValue: userCache },
      ],
    }).compile();
    const g = module.get<TrackingGateway>(TrackingGateway);

    const client = { ...makeClient({}), handshake: { auth: { token: 'jwt' } } };
    await g.handleConnection(client as any);

    expect(client.data).toEqual({ uid: 'fb1', tokenExp: inOneHour });
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});
