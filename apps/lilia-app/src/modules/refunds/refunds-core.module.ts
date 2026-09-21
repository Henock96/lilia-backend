import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RefundsService } from './refunds.service';
import { RefundExecutionService } from './refund-execution.service';
import { RefundProviderService } from './refund-provider.service';
import { PaymentCoreModule } from '../payments/payment-core.module';

/**
 * `RefundsService` seul, **sans controller**.
 *
 * Séparé de `RefundsModule` pour que les consommateurs internes — au premier
 * chef `OrderLifecycleService`, qui ouvre un remboursement à l'annulation —
 * puissent l'injecter sans entraîner `RefundsController` dans leur graphe.
 *
 * Ce n'est pas de l'esthétique : NestJS monte les controllers de **tous** les
 * modules du graphe. Le processus worker, qui importait la chaîne
 * `AppScheduleModule → OrdersModule → RefundsModule`, aurait exposé
 * `/refunds` sur son propre port — et sans les `APP_GUARD`, qui ne sont
 * déclarés que dans `AppModule`/`AuthModule`. Soit une API d'administration
 * ouverte sans authentification.
 */
@Module({
  // `PaymentCoreModule` (sans controllers) et jamais `PaymentModule` : la règle
  // ci-dessus vaut dans les deux sens — importer le module complet ferait
  // remonter `POST /admin/orders/:id/payout` dans le graphe du worker.
  imports: [PrismaModule, PaymentCoreModule],
  providers: [RefundsService, RefundExecutionService, RefundProviderService],
  exports: [RefundsService, RefundExecutionService, RefundProviderService],
})
export class RefundsCoreModule {}
