import { Module } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryAssignmentService } from './delivery-assignment.service';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { DeliveriesController } from './deliveries.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderTransitionService } from '../orders/order-transition.service';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { TrackingModule } from '../tracking/tracking.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ReferralCoreModule } from '../users/referral-core.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    PlatformSettingsModule,
    TrackingModule,
    LoyaltyModule,
    ReferralCoreModule,
  ],
  providers: [
    DeliveriesService,
    DeliveryQueryService,
    DeliveryAssignmentService,
    DeliveryAssignmentLogService,
    OrderStateMachine,
    OrderTransitionService,
  ],
  controllers: [DeliveriesController],
  // `DeliveryAssignmentLogService` est exporté parce que `DeliveriesListener`
  // — déclaré dans `AppModule`, pas ici — ferme le journal quand une commande
  // est annulée. Sans cet export, le processus web meurt au bootstrap avec
  // « Nest can't resolve dependencies of the DeliveriesListener », ce
  // qu'aucun test unitaire ne voit : l'injection se résout au démarrage.
  exports: [DeliveriesService, DeliveryAssignmentLogService],
})
export class DeliveriesModule {}
