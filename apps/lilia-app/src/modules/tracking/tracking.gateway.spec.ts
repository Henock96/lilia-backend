import { ForbiddenException } from '@nestjs/common';
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
    assertCanUpdatePosition: jest.fn(),
    updatePosition: jest.fn(),
    calculateETA: jest.fn().mockResolvedValue(7),
    getLastPosition: jest.fn().mockResolvedValue(null),
    registerWatcherRevoker: jest.fn(),
  };
  const userCache = { getByFirebaseUid: jest.fn() };

  /** Serveur Socket.io minimal : capture ce qui part sur la room. */
  const roomEmit = jest.fn();
  /** Sockets rendues par `server.in(room).fetchSockets()`, par room. */
  let socketsByRoom: Record<string, unknown[]>;
  const makeServer = () => ({
    to: jest.fn().mockReturnValue({ emit: roomEmit }),
    in: jest.fn((room: string) => ({
      fetchSockets: jest.fn().mockResolvedValue(socketsByRoom[room] ?? []),
    })),
  });

  /** Socket distante (autre instance comprise) telle que la rend l'adapter. */
  const remoteSocket = (uid: string, rooms: string[]) => ({
    data: { uid },
    rooms: new Set(rooms),
    leave: jest.fn(),
  });

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
    socketsByRoom = {};
    tracking.assertCanWatchOrder.mockResolvedValue({
      live: true,
      userId: 'u1',
    });
    // Par défaut, la course roule (`EN_TRANSIT`) : la position circule.
    tracking.assertCanUpdatePosition.mockResolvedValue({ live: true });
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
    gateway.server = makeServer() as any;
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  it('token encore valide + compte actif → la commande est bien rejointe', async () => {
    const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });

    await gateway.onWatchOrder(client as any, { orderId: 'o1' });

    expect(tracking.assertCanWatchOrder).toHaveBeenCalledWith('o1', 'fb1');
    expect(client.join).toHaveBeenCalledWith(['order:o1', 'user:u1']);
    expect(client.data.userId).toBe('u1');
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  /**
   * SEC-08 — le droit n'est vérifié qu'à l'entrée dans la room. Quand un
   * événement le retire (réassignation, ban, suppression de compte), la
   * gateway réévalue les spectateurs concernés : ceux qui l'ont perdu sortent,
   * les autres restent. Rien n'est fait à la diffusion d'une position.
   */
  describe('SEC-08 — révocation des spectateurs', () => {
    it('s’enregistre auprès du service au démarrage du module', () => {
      gateway.onModuleInit();
      expect(tracking.registerWatcherRevoker).toHaveBeenCalledWith(gateway);
    });

    it('réassignation : seul celui qui a perdu le droit sort de la room', async () => {
      const client = remoteSocket('fb-client', ['order:o1', 'user:c1']);
      const ancienLivreur = remoteSocket('fb-liv-a', ['order:o1', 'user:la']);
      socketsByRoom['order:o1'] = [client, ancienLivreur];
      tracking.assertCanWatchOrder.mockImplementation(
        (_o: string, uid: string) =>
          uid === 'fb-liv-a'
            ? Promise.reject(new ForbiddenException())
            : Promise.resolve({ live: true, userId: 'c1' }),
      );

      await gateway.revokeOrder('o1');

      expect(ancienLivreur.leave).toHaveBeenCalledWith('order:o1');
      expect(client.leave).not.toHaveBeenCalled();
    });

    it('compte banni : sort de chaque room de commande refusée, pas des autres', async () => {
      const socket = remoteSocket('fb-x', [
        'sid-1',
        'order:o1',
        'order:o2',
        'user:x',
      ]);
      socketsByRoom['user:x'] = [socket];
      tracking.assertCanWatchOrder.mockImplementation((orderId: string) =>
        orderId === 'o2'
          ? Promise.reject(new ForbiddenException())
          : Promise.resolve({ live: false, userId: 'x' }),
      );

      await gateway.revokeUser('x');

      expect(tracking.assertCanWatchOrder).toHaveBeenCalledTimes(2);
      expect(socket.leave).toHaveBeenCalledTimes(1);
      expect(socket.leave).toHaveBeenCalledWith('order:o2');
    });

    it('fermé par défaut : une erreur inattendue fait sortir de la room', async () => {
      const socket = remoteSocket('fb-x', ['order:o1']);
      socketsByRoom['order:o1'] = [socket];
      tracking.assertCanWatchOrder.mockRejectedValue(
        new Error('base indisponible'),
      );

      await gateway.revokeOrder('o1');

      expect(socket.leave).toHaveBeenCalledWith('order:o1');
    });

    it('la diffusion d’une position ne réévalue rien', () => {
      gateway.broadcastDriverPosition('o1', { lat: 1, lng: 2, eta: 3 });
      expect(tracking.assertCanWatchOrder).not.toHaveBeenCalled();
    });
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

  /**
   * `orderId` dans le payload : une socket admin peut suivre plusieurs
   * commandes à la fois. Sans lui, le client devait déduire la provenance de
   * l'event de la room qu'il pensait écouter — hypothèse fausse dès qu'il y a
   * plus d'une room.
   */
  describe('orderId dans les payloads sortants', () => {
    it('driver:position broadcast porte orderId, lat, lng, eta', async () => {
      const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });

      await gateway.onDriverPosition(client as any, {
        orderId: 'o1',
        lat: -4.2634,
        lng: 15.2429,
      });

      expect(gateway.server.to).toHaveBeenCalledWith('order:o1');
      expect(roomEmit).toHaveBeenCalledWith(
        'driver:position',
        expect.objectContaining({
          orderId: 'o1',
          lat: -4.2634,
          lng: 15.2429,
          eta: 7,
          timestamp: expect.any(Number),
        }),
      );
    });

    /**
     * F3-12.0 (I16) — avant `EN_TRANSIT` (ou après `LIVRER`), la position du
     * livreur ne doit atteindre ni Redis ni la room que le client écoute. Et
     * sans exception : l'app livreur publie en boucle, une erreur par
     * message serait du bruit sans effet.
     */
    it('F3-12.0 — hors EN_TRANSIT : ni stockée, ni diffusée, et sans erreur', async () => {
      tracking.assertCanUpdatePosition.mockResolvedValueOnce({ live: false });
      const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });

      await expect(
        gateway.onDriverPosition(client as any, {
          orderId: 'o1',
          lat: -4.2634,
          lng: 15.2429,
        }),
      ).resolves.toBeUndefined();

      expect(tracking.updatePosition).not.toHaveBeenCalled();
      expect(roomEmit).not.toHaveBeenCalled();
    });

    it('order:status broadcast porte orderId et status', () => {
      gateway.broadcastOrderStatus('o42', 'EN_ROUTE');

      expect(gateway.server.to).toHaveBeenCalledWith('order:o42');
      expect(roomEmit).toHaveBeenCalledWith(
        'order:status',
        expect.objectContaining({ orderId: 'o42', status: 'EN_ROUTE' }),
      );
    });

    it('la position rejouée sur order:watch porte aussi orderId', async () => {
      tracking.getLastPosition.mockResolvedValueOnce({
        lat: -4.26,
        lng: 15.24,
        ts: 1716480000000,
      });
      const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });

      await gateway.onWatchOrder(client as any, { orderId: 'o7' });

      expect(client.emit).toHaveBeenCalledWith(
        'driver:position',
        expect.objectContaining({ orderId: 'o7', lat: -4.26, lng: 15.24 }),
      );
    });

    it('F3-12.0 — course hors EN_TRANSIT (ex. LIVRER) : room rejointe, aucune position rejouée', async () => {
      tracking.assertCanWatchOrder.mockResolvedValueOnce({
        live: false,
        userId: 'u1',
      });
      // La clé Redis survit à la course (TTL 5 min) : elle est bien là.
      tracking.getLastPosition.mockResolvedValueOnce({
        lat: -4.26,
        lng: 15.24,
        ts: 1716480000000,
      });
      const client = makeClient({ uid: 'fb1', tokenExp: inOneHour });

      await gateway.onWatchOrder(client as any, { orderId: 'o8' });

      expect(client.join).toHaveBeenCalledWith(['order:o8', 'user:u1']);
      expect(tracking.getLastPosition).not.toHaveBeenCalled();
      expect(client.emit).not.toHaveBeenCalledWith(
        'driver:position',
        expect.anything(),
      );
    });

    it('source est conservée sur le chemin de fallback HTTP', () => {
      gateway.broadcastDriverPosition('o9', {
        lat: 1,
        lng: 2,
        eta: 3,
        source: 'http',
      });

      expect(roomEmit).toHaveBeenCalledWith(
        'driver:position',
        expect.objectContaining({ orderId: 'o9', source: 'http' }),
      );
    });

    it('aucun serveur attaché → pas de crash (services testés hors WS)', () => {
      gateway.server = undefined as any;

      expect(() =>
        gateway.broadcastDriverPosition('o1', { lat: 1, lng: 2, eta: 3 }),
      ).not.toThrow();
      expect(() => gateway.broadcastOrderStatus('o1', 'PRET')).not.toThrow();
    });
  });
});
