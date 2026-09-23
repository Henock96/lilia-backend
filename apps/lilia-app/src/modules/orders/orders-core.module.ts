import { Module } from '@nestjs/common';

import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { RefundsCoreModule } from '../refunds/refunds-core.module';
import { ReferralCoreModule } from '../users/referral-core.module';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderStateMachine } from './order-state.machine';
import { OrderTransitionService } from './order-transition.service';
import { StockService } from './stock.service';

/**
 * Cycle de vie d'une commande, **sans controller ni dépendance HTTP**.
 *
 * Extrait d'`OrdersModule` pour les processus qui ont besoin de faire avancer
 * une commande sans servir de trafic — aujourd'hui `AppScheduleModule`
 * (expiration des commandes impayées) et, à travers lui, le worker.
 *
 * Le problème que cette séparation résout est concret : NestJS monte les
 * controllers de **tous** les modules du graphe. Importer `OrdersModule`
 * depuis le worker y aurait monté `/orders`, `/refunds`, `/tracking`,
 * `/vendors`, `/notifications` et `/platform-settings` — sans les `APP_GUARD`,
 * déclarés uniquement dans `AppModule` et `AuthModule`. Le worker aurait donc
 * exposé une API non authentifiée sur son port.
 *
 * Règle à conserver : **ce module ne doit jamais déclarer de `controllers`,
 * ni importer un module qui en déclare.**
 */
@Module({
  // `AdminAuditModule` ne déclare aucun controller : l'importer ici ne monte
  // rien sur le worker (cf. `worker.module.spec.ts`).
  imports: [
    PrismaModule,
    LoyaltyModule,
    RefundsCoreModule,
    ReferralCoreModule,
    AdminAuditModule,
  ],
  providers: [
    OrderStateMachine,
    // Seul point d'écriture de `Order.status`. Fourni ici — donc par un module
    // SANS controller — parce que le worker en a besoin lui aussi :
    // `OrderExpiryService` annule les commandes impayées depuis l'autre
    // processus, et cette transition doit être historisée comme les autres.
    OrderTransitionService,
    StockService,
    OrderLifecycleService,
  ],
  exports: [
    OrderLifecycleService,
    OrderStateMachine,
    OrderTransitionService,
    StockService,
    LoyaltyModule,
    RefundsCoreModule,
    ReferralCoreModule,
  ],
})
export class OrdersCoreModule {}
