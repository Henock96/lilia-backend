/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { MenuCreatedEvent } from '../events/menu-events';

@Injectable()
export class MenusListener {
  private readonly logger = new Logger(MenusListener.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Gère l'événement de création d'un menu
   * Envoie des notifications à tous les clients qui ont déjà commandé dans ce restaurant
   */
  @OnEvent('menu.created')
  async handleMenuCreated(event: MenuCreatedEvent) {
    this.logger.log(`🔥 Handling menu created event: ${event.menuId} - ${event.menuData.nom}`);

    try {
      // Récupérer tous les clients qui ont déjà commandé dans ce restaurant
      const previousCustomers = await this.getPreviousCustomers(event.restaurantId);

      this.logger.log(
        `📊 Found ${previousCustomers.length} previous customers for restaurant ${event.restaurantId}`
      );

      // Si aucun client n'a commandé, on peut envoyer à tous les clients (optionnel)
      // Ou ne rien envoyer pour éviter le spam
      if (previousCustomers.length === 0) {
        this.logger.log('ℹ️ No previous customers found, skipping notifications');
        return;
      }

      // Préparer le message de notification
      const title = `🔥 Nouveau menu chez ${event.menuData.restaurantName}`;
      const body = `${event.menuData.nom} - ${event.menuData.prix} FCFA. Disponible maintenant !`;

      // Envoyer les notifications à tous les clients concernés
      let successCount = 0;
      let failureCount = 0;

      for (const customer of previousCustomers) {
        try {
          await this.notificationsService.sendPushNotification(
            customer.id,
            title,
            body,
            {
              menuId: event.menuId,
              restaurantId: event.restaurantId,
              type: 'new_menu',
              restaurantName: event.menuData.restaurantName,
              menuName: event.menuData.nom,
              price: event.menuData.prix.toString(),
            },
          );
          successCount++;
        } catch (error) {
          this.logger.error(
            `❌ Failed to send notification to customer ${customer.id}: ${error.message}`
          );
          failureCount++;
        }
      }

      this.logger.log(
        `✅ Menu creation notifications sent: ${successCount} succeeded, ${failureCount} failed`
      );
    } catch (error) {
      this.logger.error(
        `❌ Error handling menu created event: ${error.message}`,
        error.stack
      );
    }
  }

  /**
   * Récupère tous les clients uniques qui ont déjà commandé dans ce restaurant
   */
  private async getPreviousCustomers(restaurantId: string) {
    // Récupérer tous les userId distincts qui ont commandé dans ce restaurant
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId: restaurantId,
        // On peut filtrer pour ne garder que les commandes complétées
        status: {
          in: ['PAYER', 'EN_PREPARATION', 'PRET', 'LIVRER'],
        },
      },
      select: {
        userId: true,
      },
      distinct: ['userId'],
    });

    // Récupérer les informations des utilisateurs
    const userIds = orders.map(order => order.userId);

    if (userIds.length === 0) {
      return [];
    }

    const users = await this.prisma.user.findMany({
      where: {
        id: {
          in: userIds,
        },
        role: 'CLIENT', // Ne notifier que les clients, pas les restaurateurs/admins
      },
      select: {
        id: true,
        email: true,
        nom: true,
      },
    });

    return users;
  }

  /**
   * Alternative : Notifier TOUS les clients (à utiliser avec précaution)
   * Décommentez cette méthode si vous préférez notifier tous les clients
   */
  /*
  private async getAllClients() {
    return this.prisma.user.findMany({
      where: {
        role: 'CLIENT',
      },
      select: {
        id: true,
        email: true,
        nom: true,
      },
    });
  }
  */
}
