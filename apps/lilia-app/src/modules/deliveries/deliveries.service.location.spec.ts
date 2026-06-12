import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DeliveriesService } from './deliveries.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryAssignmentService } from './delivery-assignment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';

/**
 * LIL-54 — convergence des deux paths de tracking.
 *
 * Le path HTTP fallback (`PATCH /deliveries/:id/location` → updateLocation) doit
 * alimenter la MÊME source de vérité Redis live que le path WS
 * (`POST /tracking/position`) via `TrackingService.cacheLivePosition`, en plus
 * de son write DB. Sinon un (re)`order:watch` lirait une position périmée.
 */
describe('DeliveriesService.updateLocation (convergence Redis — LIL-54)', () => {
  let service: DeliveriesService;

  const prisma = {
    user: { findUnique: jest.fn() },
    delivery: { findUnique: jest.fn(), update: jest.fn() },
    deliveryLocation: { create: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const tracking = {
    cacheLivePosition: jest.fn().mockResolvedValue(undefined),
    calculateETA: jest.fn().mockResolvedValue(7),
  };
  const gateway = { server: undefined }; // broadcast court-circuité (?. ) — non testé ici

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: OrderStateMachine, useValue: {} },
        { provide: PlatformSettingsService, useValue: {} },
        { provide: TrackingGateway, useValue: gateway },
        { provide: TrackingService, useValue: tracking },
        { provide: DeliveryQueryService, useValue: {} },
        { provide: DeliveryAssignmentService, useValue: {} },
      ],
    }).compile();
    service = module.get<DeliveriesService>(DeliveriesService);
  });

  const arrangeValid = () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.delivery.findUnique.mockResolvedValue({
      id: 'd1',
      delivererId: 'u1',
      status: 'EN_TRANSIT',
      orderId: 'o1',
    });
  };

  it('appelle cacheLivePosition avec le bon payload (orderId/driver/coords)', async () => {
    arrangeValid();

    await service.updateLocation('d1', -4.2, 15.2, 8, 'uid');

    expect(tracking.cacheLivePosition).toHaveBeenCalledWith({
      orderId: 'o1',
      driverId: 'u1',
      lat: -4.2,
      lng: 15.2,
      accuracy: 8,
    });
    // Le write DB reste fait à chaque appel HTTP (cadence inchangée).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('un échec Redis n’empêche pas la mise à jour de position (best-effort)', async () => {
    arrangeValid();
    tracking.cacheLivePosition.mockRejectedValueOnce(new Error('redis down'));

    const res = await service.updateLocation('d1', -4.2, 15.2, 8, 'uid');

    expect(res).toEqual({ message: 'Position mise à jour', latitude: -4.2, longitude: 15.2 });
  });

  it('refuse si la livraison n’est pas assignée au livreur', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.delivery.findUnique.mockResolvedValue({
      id: 'd1',
      delivererId: 'autre',
      status: 'EN_TRANSIT',
      orderId: 'o1',
    });

    await expect(
      service.updateLocation('d1', -4.2, 15.2, 8, 'uid'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tracking.cacheLivePosition).not.toHaveBeenCalled();
  });

  it('refuse si la livraison n’est pas EN_TRANSIT', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.delivery.findUnique.mockResolvedValue({
      id: 'd1',
      delivererId: 'u1',
      status: 'ASSIGNER',
      orderId: 'o1',
    });

    await expect(
      service.updateLocation('d1', -4.2, 15.2, 8, 'uid'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
