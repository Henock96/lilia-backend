/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PAID_ORDER_STATUSES } from '../orders/order-status-groups';
import { MenuCreatedEvent } from '../events/menu-events';

@Injectable()
export class MenusListener {
  private readonly logger = new Logger(MenusListener.name);

  /**
   * Plafond de destinataires par publication de menu.
   *
   * Ce n'est pas une limite technique — `sendPushToUsers` sait diffuser en
   * lots — mais une limite **métier** : au-delà, une publication de menu
   * devient une campagne de masse, qui appelle une décision et un outil, pas
   * un effet de bord de `POST /menus`.
   */
  private static readonly MAX_AUDIENCE = 500;

  /**
   * Fenêtre d'ancienneté des clients notifiés.
   *
   * Quelqu'un qui a commandé une fois il y a deux ans n'est pas un client de ce
   * vendeur, et le prévenir d'un menu du jour est du spam — qui coûte en plus
   * un jeton FCM et le risque d'une désinstallation.
   */
  private static readonly AUDIENCE_WINDOW_DAYS = 90;

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

      // ⚠️ Diffusion EN LOTS, plus une boucle séquentielle.
      //
      // Chaque tour de l'ancienne boucle coûtait une requête `FcmToken` **et**
      // un aller-retour FCM, en série, dans le processus web. Mille clients
      // valaient deux mille opérations bloquantes déclenchées par un simple
      // `POST /menus` — et un vendeur qui publie vingt menus en déclenchait
      // vingt rafales.
      const { sent, failed, devices } =
        await this.notificationsService.sendPushToUsers(
          previousCustomers.map((c) => c.id),
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

      this.logger.log(
        `✅ Nouveau menu diffusé : ${sent}/${devices} appareil(s), ${failed} échec(s), ` +
          `${previousCustomers.length} destinataire(s)`
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
    // ⚠️ Audience BORNÉE, et bornée aux clients RÉCENTS.
    //
    // La requête d'origine ne portait ni `take` ni fenêtre temporelle : elle
    // rendait tous les clients ayant jamais commandé chez ce vendeur, pour leur
    // envoyer un message promotionnel. Deux problèmes distincts — le coût, et
    // le fait qu'un client parti depuis deux ans n'attend pas de publicité.
    //
    // La borne est ici et non dans `NotificationsService` : « combien de
    // personnes ai-je le droit de déranger » est une question métier, pas une
    // question de transport.
    const since = new Date();
    since.setDate(since.getDate() - MenusListener.AUDIENCE_WINDOW_DAYS);

    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId: restaurantId,
        // Seules les commandes réellement honorées : une commande abandonnée
        // ne fait pas de quelqu'un un client.
        status: { in: [...PAID_ORDER_STATUSES] },
        createdAt: { gte: since },
      },
      select: {
        userId: true,
      },
      distinct: ['userId'],
      orderBy: { createdAt: 'desc' },
      take: MenusListener.MAX_AUDIENCE,
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
