import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * L'envoi de push FCM, **sans le controller d'enregistrement de token**.
 *
 * Presque tout le backend notifie : listeners, crons, outbox. Aucun de ces
 * consommateurs n'a besoin de `POST /notifications/register-token`, qui est le
 * seul rôle de `NotificationsController` et n'a de sens que dans le processus
 * qui sert les applications mobiles.
 *
 * La distinction compte parce que NestJS monte les controllers de tous les
 * modules du graphe : le worker, qui importe ce module pour l'escalade SMS et
 * les crons, aurait exposé `register-token` et `DELETE /notifications/token`
 * sur son port — sans `FirebaseAuthGuard`, absent de son graphe. N'importe qui
 * aurait pu associer un token FCM à un compte, ou détruire celui d'un autre.
 */
@Module({
  imports: [PrismaModule],
  providers: [NotificationsService, FirebaseService],
  exports: [NotificationsService],
})
export class NotificationsCoreModule {}
