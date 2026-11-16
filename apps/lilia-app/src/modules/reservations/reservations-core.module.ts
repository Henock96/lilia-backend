import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { ReservationLifecycleService } from './reservation-lifecycle.service';

/**
 * Lot 4 — ce que le temps fait aux réservations (expirations, rappels,
 * récapitulatif), **sans controller**.
 *
 * ⚠️ Chargé par le worker via `AppScheduleModule` : un module du graphe du
 * worker ne déclare jamais de controller ni n'importe un module qui en déclare
 * (`worker.module.spec.ts`). `OutboxModule`, lui, est global des deux côtés.
 */
@Module({
  imports: [PrismaModule],
  providers: [ReservationLifecycleService],
  exports: [ReservationLifecycleService],
})
export class ReservationsCoreModule {}
