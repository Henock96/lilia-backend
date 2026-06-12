import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Smoke test DI TrackingService (LIL-106).
 *
 * Mocke `PrismaService` + `ConfigService` (utilisé dans le constructor pour
 * lire `REDIS_URL`). On retourne `undefined` → le service log un warning et
 * passe `this.redis = null`, comportement attendu hors environnement Redis.
 */
describe('TrackingService', () => {
  let service: TrackingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingService,
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();

    service = module.get<TrackingService>(TrackingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── cacheLivePosition : source de vérité Redis partagée WS/HTTP (LIL-54) ───
  describe('cacheLivePosition', () => {
    it('écrit GEO + métadonnées TTL dans Redis', async () => {
      const redis = { geoadd: jest.fn(), setex: jest.fn() };
      (service as any).redis = redis;

      await service.cacheLivePosition({
        orderId: 'o1',
        driverId: 'd1',
        lat: -4.26,
        lng: 15.24,
        accuracy: 5,
      });

      expect(redis.geoadd).toHaveBeenCalledWith(
        'driver_positions',
        15.24,
        -4.26,
        'd1',
      );
      const [key, ttl, payload] = redis.setex.mock.calls[0];
      expect(key).toBe('delivery:o1');
      expect(ttl).toBe(300);
      expect(JSON.parse(payload)).toMatchObject({
        lat: -4.26,
        lng: 15.24,
        accuracy: 5,
      });
    });

    it('no-op si Redis absent (best-effort)', async () => {
      (service as any).redis = null;
      await expect(
        service.cacheLivePosition({ orderId: 'o1', driverId: 'd1', lat: 1, lng: 2 }),
      ).resolves.toBeUndefined();
    });
  });

  describe('updatePosition', () => {
    it('alimente le cache live (geoadd + setex) puis pose le verrou persist', async () => {
      // set NX → null : le verrou existe déjà, pas de write DB (Prisma non sollicité)
      const redis = {
        geoadd: jest.fn(),
        setex: jest.fn(),
        set: jest.fn().mockResolvedValue(null),
      };
      (service as any).redis = redis;

      await service.updatePosition({
        orderId: 'o1',
        driverId: 'd1',
        lat: -4.2,
        lng: 15.2,
      });

      expect(redis.geoadd).toHaveBeenCalledWith('driver_positions', 15.2, -4.2, 'd1');
      expect(redis.setex).toHaveBeenCalledWith('delivery:o1', 300, expect.any(String));
      expect(redis.set).toHaveBeenCalledWith('persist_lock:o1', '1', 'EX', 60, 'NX');
    });
  });
});
