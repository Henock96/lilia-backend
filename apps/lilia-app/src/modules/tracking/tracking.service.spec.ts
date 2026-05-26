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
});
