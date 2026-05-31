/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Rappel J-1 pour les commandes programmées (LIL-121, décision 3c).
 *
 * Chaque matin à 8h heure locale (UTC+1, pas de DST en Afrique centrale),
 * push aux propriétaires des vendeurs avec la liste des commandes
 * `scheduledFor` qui tombent dans les prochaines 24h. Aide la pâtissière à
 * planifier ses achats/production en début de journée.
 *
 * Le créneau cible est [maintenant, maintenant + 24h] plutôt que stricto
 * "demain". Si la cliente programme pour 17h aujourd'hui et que le cron
 * tourne à 8h, on veut quand même envoyer le rappel — sinon elle ne le
 * verrait jamais.
 */
@Injectable()
export class PreorderReminderService {
  private readonly logger = new Logger(PreorderReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // 8h00 heure locale (Brazzaville UTC+1) = 7h00 UTC.
  @Cron('0 7 * * *', { name: 'preorder-reminder-daily' })
  async sendDailyReminders(): Promise<void> {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 3600 * 1000);

    // Commandes programmées dans les 24h, pas annulées, status pertinent
    // (non LIVRER) — on ignore les commandes déjà terminées.
    const upcoming = await this.prisma.order.findMany({
      where: {
        scheduledFor: { gte: now, lte: in24h },
        status: { notIn: ['ANNULER', 'LIVRER'] },
      },
      select: {
        id: true,
        scheduledFor: true,
        restaurantId: true,
        restaurant: {
          select: {
            nom: true,
            owner: { select: { id: true } },
          },
        },
      },
      orderBy: { scheduledFor: 'asc' },
    });

    if (upcoming.length === 0) {
      this.logger.log('Aucune commande programmée dans les 24h — pas de rappel.');
      return;
    }

    // Group by vendor pour envoyer 1 notif par vendeur (pas 1 par commande)
    const byVendor = new Map<
      string,
      { vendorName: string; ownerId: string; count: number; nextAt: Date }
    >();

    for (const order of upcoming) {
      const ownerId = order.restaurant.owner.id;
      const existing = byVendor.get(order.restaurantId);
      if (existing) {
        existing.count += 1;
      } else {
        byVendor.set(order.restaurantId, {
          vendorName: order.restaurant.nom,
          ownerId,
          count: 1,
          nextAt: order.scheduledFor!,
        });
      }
    }

    this.logger.log(
      `Rappel J-1 : ${upcoming.length} commandes pour ${byVendor.size} vendeurs.`,
    );

    await Promise.allSettled(
      Array.from(byVendor.values()).map((entry) =>
        this.notifications.sendPushNotification(
          entry.ownerId,
          '📋 Commandes à préparer',
          `${entry.count} commande${entry.count > 1 ? 's' : ''} programmée${entry.count > 1 ? 's' : ''} dans les 24h chez ${entry.vendorName}. ` +
            `Prochaine : ${entry.nextAt.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}.`,
          { type: 'preorder_reminder', vendorName: entry.vendorName },
        ),
      ),
    );
  }
}
