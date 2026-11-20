import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { OrdersCoreModule } from '../orders/orders-core.module';
import { ReservationLifecycleService } from './reservation-lifecycle.service';
import { ReservationOrderRelease } from './reservation-order-release';

/**
 * Lot 4 — ce que le temps fait aux réservations (expirations, rappels,
 * récapitulatif), **sans controller**.
 *
 * ⚠️ Chargé par le worker via `AppScheduleModule` : un module du graphe du
 * worker ne déclare jamais de controller ni n'importe un module qui en déclare
 * (`worker.module.spec.ts`). `OutboxModule`, lui, est global des deux côtés.
 */
@Module({
  // `OrdersCoreModule` est sans controller (règle du worker) : la commande
  // liée d'une réservation qui expire est annulée dans la même transaction.
  imports: [PrismaModule, OrdersCoreModule],
  providers: [ReservationLifecycleService, ReservationOrderRelease],
  exports: [ReservationLifecycleService, ReservationOrderRelease],
})
export class ReservationsCoreModule {}
