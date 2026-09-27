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
  const service = {
    assertCanUpdatePosition: jest.fn(),
    updatePosition: jest.fn(),
    calculateETA: jest.fn(),
  };
  const gateway = { broadcastDriverPosition: jest.fn() };
  const fbUser = { uid: 'fb-liv-1' } as never;
  const point = { lat: -4.26, lng: 15.28, accuracy: 10 };

  beforeEach(async () => {
    jest.clearAllMocks();
    service.calculateETA.mockResolvedValue(7);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrackingController],
      providers: [
        { provide: TrackingService, useValue: service },
        { provide: TrackingGateway, useValue: gateway },
      ],
    }).compile();

    controller = module.get<TrackingController>(TrackingController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  /**
   * F3-12.0 — hors `EN_TRANSIT`, la position est acquittée (2xx) sans être
   * stockée ni diffusée. Un 4xx ferait rejouer indéfiniment la file hors
   * ligne de l'app livreur.
   */
  describe('F3-12.0 — hors EN_TRANSIT : acquitté, ni stocké ni diffusé', () => {
    beforeEach(() => {
      service.assertCanUpdatePosition.mockResolvedValue({ live: false });
    });

    it('POST /tracking/position', async () => {
      await expect(
        controller.updatePosition(fbUser, { orderId: 'o1', ...point }),
      ).resolves.toEqual({ eta: null });
      expect(service.updatePosition).not.toHaveBeenCalled();
      expect(gateway.broadcastDriverPosition).not.toHaveBeenCalled();
    });

    it('POST /tracking/position/batch : le lot entier est compté comme synchronisé', async () => {
      await expect(
        controller.batchPositions(fbUser, {
          orderId: 'o1',
          positions: [point, point, point],
        } as never),
      ).resolves.toEqual({ synced: 3, eta: null });
      expect(service.updatePosition).not.toHaveBeenCalled();
      expect(gateway.broadcastDriverPosition).not.toHaveBeenCalled();
    });
  });

  describe('EN_TRANSIT : stocké et diffusé', () => {
    beforeEach(() => {
      service.assertCanUpdatePosition.mockResolvedValue({ live: true });
    });

    it('POST /tracking/position', async () => {
      await expect(
        controller.updatePosition(fbUser, { orderId: 'o1', ...point }),
      ).resolves.toEqual({ eta: 7 });
      expect(service.updatePosition).toHaveBeenCalledTimes(1);
      expect(gateway.broadcastDriverPosition).toHaveBeenCalledWith(
        'o1',
        expect.objectContaining({ lat: point.lat, lng: point.lng }),
      );
    });

    it('POST /tracking/position/batch : seule la dernière position circule', async () => {
      const last = { lat: -4.3, lng: 15.3, accuracy: 5 };
      await expect(
        controller.batchPositions(fbUser, {
          orderId: 'o1',
          positions: [point, last],
        } as never),
      ).resolves.toEqual({ synced: 2, eta: 7 });
      expect(service.updatePosition).toHaveBeenCalledWith(
        expect.objectContaining({ lat: last.lat, lng: last.lng }),
      );
      expect(gateway.broadcastDriverPosition).toHaveBeenCalledTimes(1);
    });
  });
});
