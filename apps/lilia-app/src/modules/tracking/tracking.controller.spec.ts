import { Test, TestingModule } from '@nestjs/testing';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { TrackingGateway } from './tracking.gateway';

/**
 * Smoke test DI TrackingController (LIL-106).
 *
 * Mocke les deux deps directes : `TrackingService` (assertCanUpdatePosition,
 * updatePosition, calculateETA) et `TrackingGateway` (broadcast).
 */
describe('TrackingController', () => {
  let controller: TrackingController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrackingController],
      providers: [
        { provide: TrackingService, useValue: {} },
        { provide: TrackingGateway, useValue: {} },
      ],
    }).compile();

    controller = module.get<TrackingController>(TrackingController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
