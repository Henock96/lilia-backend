import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RefundsService } from './refunds.service';

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
  imports: [PrismaModule],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsCoreModule {}
