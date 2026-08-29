import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { RefundsCoreModule } from '../refunds/refunds-core.module';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderStateMachine } from './order-state.machine';
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
  imports: [PrismaModule, LoyaltyModule, RefundsCoreModule],
  providers: [OrderStateMachine, StockService, OrderLifecycleService],
  exports: [
    OrderLifecycleService,
    OrderStateMachine,
    StockService,
    LoyaltyModule,
    RefundsCoreModule,
  ],
})
export class OrdersCoreModule {}
