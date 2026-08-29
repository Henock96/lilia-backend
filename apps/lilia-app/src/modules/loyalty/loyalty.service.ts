import { Injectable, Logger } from '@nestjs/common';
import { LoyaltyTransactionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * Crédit des points de fidélité à la livraison — implémentation **unique** et
 * **idempotente** (fix M5, audit du 28/08/2026).
 *
 * Deux chemins mènent une commande à `LIVRER` — `PATCH /orders/:id/status` et
 * `PATCH /deliveries/:id/status` — et chacun portait sa propre copie de
 * `awardLoyaltyPoints`, sans écriture conditionnelle : joués en concurrence,
 * ils créditaient deux fois. L'idempotence repose désormais sur la contrainte
 * `LoyaltyTransaction @@unique([orderId, type])` : la seconde écriture lève un
 * P2002 et la transaction entière est annulée, solde compris.
 */
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  /**
   * Crédite +N pts par 100 XAF de sous-total pour une commande livrée.
   * Rejouer l'appel sur la même commande est sans effet.
   */
  async awardForDeliveredOrder(
    userId: string,
    orderId: string,
    subTotal: number,
  ): Promise<void> {
    const settings = await this.platformSettings.getSettings();
    const points = Math.floor(subTotal / 100) * settings.loyaltyPointsPer100Xaf;
    if (points <= 0) return;

    try {
      await this.prisma.$transaction([
        // La création vient en premier : c'est elle qui porte la contrainte
        // d'unicité, donc c'est elle qui doit faire échouer le doublon avant
        // que le solde ne bouge.
        this.prisma.loyaltyTransaction.create({
          data: {
            userId,
            orderId,
            points,
            type: LoyaltyTransactionType.ORDER_EARN,
            reason: `+${points} pts — commande livrée`,
          },
        }),
        this.prisma.user.update({
          where: { id: userId },
          data: { loyaltyPoints: { increment: points } },
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.log(
          `⭐ Points déjà crédités pour la commande ${orderId} — second appel ignoré`,
        );
        return;
      }
      throw error;
    }

    this.logger.log(
      `⭐ +${points} points fidélité user ${userId} (commande ${orderId})`,
    );
  }
}
