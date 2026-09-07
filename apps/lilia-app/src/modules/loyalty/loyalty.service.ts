import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LoyaltyTransactionType, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { LoyaltyPointsEarnedEvent } from '../events/loyalty-events';

/**
 * Crédit des points de fidélité à la livraison — implémentation **unique** et
 * **idempotente**.
 *
 * ## La règle (septembre 2026)
 *
 * Une commande livrée vaut un **forfait** : `loyaltyPointsPerOrder`, quel que
 * soit son montant. Une commande de 1 000 XAF et une de 20 000 XAF rapportent
 * la même chose.
 *
 * Le gain était auparavant proportionnel (`floor(subTotal / 100) × N`). Cette
 * formule est supprimée, pas reparamétrée : aucune valeur de `N` n'y produit un
 * forfait, et `loyaltyPointsPer100Xaf` a été retiré du schéma plutôt que
 * détourné vers un sens que son nom ne dit plus.
 *
 * ## Le garde-fou anti-boucle
 *
 * **Une commande qui a consommé des points n'en rapporte aucun.**
 *
 * Sans lui, le forfait crée une machine perpétuelle : un point vaut 50 XAF,
 * donc une commande dont il reste au moins 50 XAF à payer convertit un point en
 * 50 XAF de remise… et en rend un à la livraison. Le solde ne descend jamais
 * pendant que le client consomme. La règle proportionnelle fermait cette boucle
 * d'elle-même (on gagnait 5 % de ce qu'on dépensait) ; le forfait ne le fait
 * pas, il faut donc l'écrire.
 *
 * La décision se lit sur `Order.loyaltyPointsUsed`, **relu en base ici** et non
 * reçu en paramètre : un appelant ne peut pas se tromper sur une valeur qu'il
 * ne fournit pas.
 *
 * ## L'idempotence
 *
 * Deux chemins mènent à `LIVRER` — `PATCH /orders/:id/status` et
 * `PATCH /deliveries/:id/status` — et chacun portait sa propre copie du crédit.
 * L'idempotence repose sur la contrainte
 * `LoyaltyTransaction @@unique([orderId, type])` : la seconde écriture lève un
 * P2002 et la transaction entière est annulée, solde compris. C'est la base qui
 * arbitre, pas un `if`.
 */
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Crédite le forfait de fidélité pour une commande livrée.
   * Rejouer l'appel sur la même commande est sans effet.
   */
  async awardForDeliveredOrder(userId: string, orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { loyaltyPointsUsed: true },
    });
    if (!order) {
      this.logger.error(
        `Crédit de fidélité impossible : commande ${orderId} introuvable`,
      );
      return;
    }

    if (order.loyaltyPointsUsed > 0) {
      this.logger.log(
        `⭐ Commande ${orderId} réglée en partie avec ${order.loyaltyPointsUsed} pt(s) — aucun point gagné (garde-fou anti-boucle)`,
      );
      return;
    }

    const settings = await this.platformSettings.getSettings();
    const points = settings.loyaltyPointsPerOrder;
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
            reason: `+${points} pt — commande livrée`,
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
      `⭐ +${points} point(s) fidélité user ${userId} (commande ${orderId})`,
    );

    // Hors transaction : voir l'en-tête de `events/loyalty-events.ts`.
    this.eventEmitter.emit(
      'loyalty.points.earned',
      new LoyaltyPointsEarnedEvent(
        userId,
        orderId,
        points,
        settings.loyaltyPointValueXaf,
      ),
    );
  }
}
