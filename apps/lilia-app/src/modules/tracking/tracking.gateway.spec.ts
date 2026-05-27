import { Test, TestingModule } from '@nestjs/testing';
import { TrackingGateway } from './tracking.gateway';
import { TrackingService } from './tracking.service';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Smoke test DI TrackingGateway (LIL-106).
 *
 * Mocke `TrackingService` + `FirebaseService` (utilisé pour vérifier le ID
 * token sur `handleConnection`).
 */
describe('TrackingGateway', () => {
  let gateway: TrackingGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingGateway,
        { provide: TrackingService, useValue: {} },
        { provide: FirebaseService, useValue: { getAuth: jest.fn() } },
      ],
    }).compile();

    gateway = module.get<TrackingGateway>(TrackingGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });
});
