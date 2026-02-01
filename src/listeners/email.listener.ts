/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserCreatedEvent } from '../events/user-events';
import { MenuCreatedEvent } from '../events/menu-events';

@Injectable()
export class EmailListener {
  private readonly logger = new Logger(EmailListener.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Envoie un email de bienvenue lors de la creation d'un nouvel utilisateur
   */
  @OnEvent('user.created')
  async handleUserCreated(event: UserCreatedEvent) {
    this.logger.log(`📧 Handling user created event for email: ${event.userId}`);

    // Ne pas envoyer d'email si le service n'est pas configure
    if (!this.emailService.isReady()) {
      this.logger.warn('⚠️ Email service not configured, skipping welcome email');
      return;
    }

    try {
      // Recuperer les informations de l'utilisateur depuis la base de donnees
      const user = await this.prisma.user.findUnique({
        where: { id: event.userId },
        select: { email: true, nom: true, createdAt: true },
      });

      if (!user || !user.email) {
        this.logger.warn(`⚠️ User ${event.userId} not found or has no email`);
        return;
      }

      // Verifier si c'est bien une nouvelle inscription (cree dans les 5 dernieres minutes)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (user.createdAt < fiveMinutesAgo) {
        this.logger.log(`ℹ️ User ${event.userId} is not new, skipping welcome email`);
        return;
      }

      // Envoyer l'email de bienvenue
      const success = await this.emailService.sendWelcomeEmail(
        user.email,
        user.nom || user.email.split('@')[0],
      );

      if (success) {
        this.logger.log(`✅ Welcome email sent to ${user.email}`);
      }
    } catch (error) {
      this.logger.error(
        `❌ Error sending welcome email for user ${event.userId}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Envoie des emails promotionnels lors de la creation d'un nouveau menu
   */
  @OnEvent('menu.created')
  async handleMenuCreatedForEmail(event: MenuCreatedEvent) {
    this.logger.log(`📧 Handling menu created event for emails: ${event.menuId}`);

    // Ne pas envoyer d'email si le service n'est pas configure
    if (!this.emailService.isReady()) {
      this.logger.warn('⚠️ Email service not configured, skipping promotional emails');
      return;
    }

    try {
      // Recuperer tous les clients qui ont deja commande dans ce restaurant
      const previousCustomers = await this.getPreviousCustomersWithEmail(event.restaurantId);

      this.logger.log(
        `📊 Found ${previousCustomers.length} previous customers with email for restaurant ${event.restaurantId}`,
      );

      if (previousCustomers.length === 0) {
        this.logger.log('ℹ️ No previous customers with email found, skipping promotional emails');
        return;
      }

      // Limiter le nombre d'emails a 100 pour eviter les problemes de performance/quota
      const customersToEmail = previousCustomers.slice(0, 100);

      let successCount = 0;
      let failureCount = 0;

      for (const customer of customersToEmail) {
        try {
          const success = await this.emailService.sendNewMenuEmail(
            customer.email,
            customer.nom || customer.email.split('@')[0],
            {
              menuName: event.menuData.nom,
              restaurantName: event.menuData.restaurantName,
              price: event.menuData.prix,
              description: event.menuData.description,
              imageUrl: event.menuData.imageUrl,
            },
          );

          if (success) {
            successCount++;
          } else {
            failureCount++;
          }

          // Petit delai entre les emails pour eviter de surcharger l'API
          await this.delay(100);
        } catch (error) {
          this.logger.error(
            `❌ Failed to send promotional email to ${customer.email}: ${error.message}`,
          );
          failureCount++;
        }
      }

      this.logger.log(
        `✅ Promotional emails sent: ${successCount} succeeded, ${failureCount} failed`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Error handling menu created event for emails: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Recupere tous les clients uniques avec email qui ont deja commande dans ce restaurant
   */
  private async getPreviousCustomersWithEmail(restaurantId: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId: restaurantId,
        status: {
          in: ['PAYER', 'EN_PREPARATION', 'PRET', 'LIVRER'],
        },
      },
      select: {
        userId: true,
      },
      distinct: ['userId'],
    });

    const userIds = orders.map((order) => order.userId);

    if (userIds.length === 0) {
      return [];
    }

    const users = await this.prisma.user.findMany({
      where: {
        id: {
          in: userIds,
        },
        role: 'CLIENT',
        email: {
          not: null,
        },
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
   * Utilitaire pour ajouter un delai
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
