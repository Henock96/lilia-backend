/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RestaurantScheduleService } from './restaurant-schedule.service';
import { PreorderReminderService } from './preorder-reminder.service';
import { OrderExpiryService } from './order-expiry.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { TrackingRetentionService } from './tracking-retention.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { OrdersCoreModule } from '../orders/orders-core.module';
import { PaymentCoreModule } from '../payments/payment-core.module';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        NotificationsCoreModule,
        OrdersCoreModule,
        // `PaymentCoreModule` et non `PaymentModule` : ce module est chargé par
        // le worker, qui ne monte aucun guard. Importer le module complet y
        // exposerait `POST /admin/orders/:id/payout` sans authentification.
        PaymentCoreModule,
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
        PaymentReconciliationService,
        TrackingRetentionService,
        PrismaService,
    ],
})
export class AppScheduleModule {}
