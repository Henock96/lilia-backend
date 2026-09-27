import { Test, TestingModule } from '@nestjs/testing';
import {
  LIVE_BATCH_MAX_AGE_MS,
  TrackingController,
} from './tracking.controller';
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
  /** Point d'un lot, relevé il y a `ageMs`. */
  const buffered = (ageMs: number, lat = -4.26) => ({
    lat,
    lng: 15.28,
    accuracy: 10,
    timestamp: Date.now() - ageMs,
  });

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
          positions: [buffered(0), buffered(0), buffered(0)],
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

    it('POST /tracking/position/batch : 3 points, seul le plus récent circule', async () => {
      const latest = buffered(1_000, -4.3);
      await expect(
        controller.batchPositions(fbUser, {
          orderId: 'o1',
          positions: [buffered(20_000), buffered(10_000), latest],
        } as never),
      ).resolves.toEqual({ synced: 3, eta: 7 });
      expect(service.updatePosition).toHaveBeenCalledTimes(1);
      expect(service.updatePosition).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'o1', lat: latest.lat }),
      );
      expect(gateway.broadcastDriverPosition).toHaveBeenCalledTimes(1);
      expect(gateway.broadcastDriverPosition).toHaveBeenCalledWith(
        'o1',
        expect.objectContaining({ lat: latest.lat, source: 'http-batch' }),
      );
    });

    /**
     * F3-12.1 R8 — l'app trie ses lots, mais le contrat ne l'impose pas : le
     * dernier élément du tableau n'est pas forcément la position actuelle.
     */
    it('lot désordonné : le point le plus récent par horodatage, pas le dernier du tableau', async () => {
      const latest = buffered(1_000, -4.3);
      await controller.batchPositions(fbUser, {
        orderId: 'o1',
        positions: [latest, buffered(30_000, -4.1)],
      } as never);
      expect(service.updatePosition).toHaveBeenCalledWith(
        expect.objectContaining({ lat: latest.lat }),
      );
    });

    /**
     * F3-12.1 (décision Q5) — un lot rejoué après une longue coupure est
     * acquitté (l'app le retire de sa file) mais n'est pas diffusé comme
     * position en direct : le marqueur du client reculerait.
     */
    it('Q5 — point le plus récent trop vieux : acquitté, ni stocké ni diffusé', async () => {
      await expect(
        controller.batchPositions(fbUser, {
          orderId: 'o1',
          positions: [
            buffered(LIVE_BATCH_MAX_AGE_MS + 60_000),
            buffered(LIVE_BATCH_MAX_AGE_MS + 1_000),
          ],
        } as never),
      ).resolves.toEqual({ synced: 2, eta: null });
      expect(service.updatePosition).not.toHaveBeenCalled();
      expect(gateway.broadcastDriverPosition).not.toHaveBeenCalled();
    });

    it('Q5 — juste sous le seuil : diffusé', async () => {
      await controller.batchPositions(fbUser, {
        orderId: 'o1',
        positions: [buffered(LIVE_BATCH_MAX_AGE_MS - 5_000)],
      } as never);
      expect(gateway.broadcastDriverPosition).toHaveBeenCalledTimes(1);
    });
  });
});
