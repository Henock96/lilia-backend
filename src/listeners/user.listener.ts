/* eslint-disable prettier/prettier */
import { Injectable,Logger } from "@nestjs/common";
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserCreatedEvent } from "src/events/user-events";
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class UserListener {
  private readonly logger = new Logger(UserListener.name);
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
    ) {}

    // ===== CRÉATION DE COMMANDE =====
      @OnEvent('user.created')
      async handleUserCreated(event: UserCreatedEvent) {
        this.logger.log(`Handling user created event: ${event.userId}`);

        try {
            
          // 2. Notification au restaurateur
          //await this.notifyRestaurantNewUserCreate(event);

          this.logger.log(`Notifications de création de user envoyées pour: ${event.userId}`);
        } catch (error) {
          this.logger.error(`Erreur lors de la gestion de l'événement de création de commande: ${error.message}`, error.stack);
        }
      }


}