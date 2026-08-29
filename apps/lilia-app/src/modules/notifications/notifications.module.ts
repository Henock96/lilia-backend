import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from './notifications-core.module';
import { NotificationsController } from './notifications.controller';

/**
 * Ajoute l'exposition HTTP (enregistrement du token FCM par les apps mobiles)
 * au service porté par `NotificationsCoreModule`.
 *
 * Un consommateur qui veut seulement **envoyer** des notifications doit
 * importer le module core : voir `notifications-core.module.ts`.
 */
@Module({
  imports: [NotificationsCoreModule],
  controllers: [NotificationsController],
  exports: [NotificationsCoreModule],
})
export class NotificationsModule {}
