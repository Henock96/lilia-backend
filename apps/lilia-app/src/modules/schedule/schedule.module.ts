/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RestaurantScheduleService } from './restaurant-schedule.service';
import { PreorderReminderService } from './preorder-reminder.service';
import { OrderExpiryService } from './order-expiry.service';
import { OrderAcceptanceTimeoutService } from './order-acceptance-timeout.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { WebhookSilenceService } from './webhook-silence.service';
import { TrackingRetentionService } from './tracking-retention.service';
import { PrismaService } from '../../prisma/prisma.service';
import { VendorOpeningService } from '../vendors/vendor-opening.service';
import { OpsQueueService } from '../ops/ops-queue.service';
import { OpsSlaScanService } from '../ops/ops-sla-scan.service';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { OrdersCoreModule } from '../orders/orders-core.module';
import { PaymentCoreModule } from '../payments/payment-core.module';
import { RefundsCoreModule } from '../refunds/refunds-core.module';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        NotificationsCoreModule,
        OrdersCoreModule,
        // `PaymentCoreModule` et non `PaymentModule` : ce module est chargé par
        // le worker, qui ne monte aucun guard. Importer le module complet y
        // exposerait `POST /admin/orders/:id/payout` sans authentification.
        PaymentCoreModule,
        // Le cron réconcilie aussi les remboursements client restés PROCESSING.
        RefundsCoreModule,
    ],
    providers: [
        // Les 5 crons sont toujours enregistrés. Le choix « ce processus
        // exécute-t-il les tâches de fond ? » est pris à l'exécution, dans
        // `CronLockService.runExclusively` : un filtre ici s'évaluerait à
        // l'import du module, avant que `ConfigModule` n'ait lu le `.env`
        // (audit post-correction, B-2).
        RestaurantScheduleService,
        PreorderReminderService,
        OrderExpiryService,
        OrderAcceptanceTimeoutService,
        PaymentReconciliationService,
        WebhookSilenceService,
        TrackingRetentionService,
        // F3-03 : la règle d'ouverture partagée avec le checkout.
        VendorOpeningService,
        // F3-04 : alerting métier du cockpit ops.
        OpsQueueService,
        OpsSlaScanService,
        PrismaService,
    ],
})
export class AppScheduleModule {}
