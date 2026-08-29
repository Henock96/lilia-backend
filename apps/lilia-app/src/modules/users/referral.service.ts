import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoyaltyTransactionType, OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * Récompenses de parrainage (fix C3 — audit du 28/08/2026).
 *
 * AVANT : `OrderCheckoutService.handleReferralReward` créditait parrain et
 * filleul **juste après la création de la commande**, donc avant tout paiement,
 * avec pour seule garde `orderCount !== 1` (qui comptait aussi les commandes
 * `EN_ATTENTE` et `ANNULER`). Créer un compte, ajouter un produit, valider le
 * panier et ne jamais payer suffisait à fabriquer des points de fidélité —
 * directement convertibles en réduction (1 pt = 5 XAF).
 *
 * MAINTENANT :
 *  1. la récompense n'est émise que sur `order.payment.confirmed` ;
 *  2. la commande doit être **la première réellement payée** du filleul ;
 *  3. l'attribution passe par un `updateMany` conditionné sur
 *     `referralRewarded = false` : deux paiements concurrents ne peuvent pas
 *     récompenser deux fois ;
 *  4. deux garde-fous anti-fermes-à-comptes : le filleul doit avoir renseigné
 *     un téléphone, et le parrain est plafonné à N filleuls récompensés sur
 *     30 jours glissants (`REFERRAL_MAX_REWARDS_PER_MONTH`, défaut 10).
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  /** Statuts qui prouvent qu'une commande a été payée. */
  private static readonly PAID_STATUSES: OrderStatus[] = [
    OrderStatus.PAYER,
    OrderStatus.EN_PREPARATION,
    OrderStatus.PRET,
    OrderStatus.EN_ROUTE,
    OrderStatus.LIVRER,
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly config: ConfigService,
  ) {}

  private get maxRewardsPerMonth(): number {
    return Number(
      this.config.get<string>('REFERRAL_MAX_REWARDS_PER_MONTH') ?? 10,
    );
  }

  /**
   * Récompense parrain + filleul si la commande qui vient d'être payée est la
   * première commande payée de ce filleul. Idempotent et sûr en concurrence.
   */
  async rewardIfFirstPaidOrder(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referredByCode: true, referralRewarded: true, phone: true },
    });
    if (!user?.referredByCode || user.referralRewarded) return;

    // Garde anti-multi-comptes : un compte sans téléphone n'a coûté qu'une
    // adresse e-mail jetable. Le parrainage reste acquis (referralRewarded
    // n'est pas posé), il se déclenchera si le filleul complète son profil et
    // repaie une commande.
    if (!user.phone?.trim()) {
      this.logger.warn(
        `Parrainage ignoré pour ${userId} : aucun téléphone renseigné.`,
      );
      return;
    }

    // « Première commande PAYÉE », pas « première commande créée ».
    const paidOrderCount = await this.prisma.order.count({
      where: { userId, status: { in: ReferralService.PAID_STATUSES } },
    });
    if (paidOrderCount !== 1) return;

    const referrer = await this.prisma.user.findUnique({
      where: { referralCode: user.referredByCode },
      select: { id: true },
    });
    // Un compte ne peut pas se parrainer lui-même.
    if (!referrer || referrer.id === userId) return;

    if (await this.hasReachedMonthlyCap(referrer.id)) {
      this.logger.warn(
        `Plafond de parrainage atteint pour ${referrer.id} (${this.maxRewardsPerMonth}/30j) — filleul ${userId} non récompensé.`,
      );
      return;
    }

    const settings = await this.platformSettings.getSettings();

    // Verrou logique : seul le premier gagnant du updateMany crédite.
    const claimed = await this.prisma.user.updateMany({
      where: { id: userId, referralRewarded: false },
      data: { referralRewarded: true },
    });
    if (claimed.count === 0) return;

    try {
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: referrer.id },
          data: { loyaltyPoints: { increment: settings.referrerBonusPoints } },
        }),
        this.prisma.loyaltyTransaction.create({
          data: {
            userId: referrer.id,
            points: settings.referrerBonusPoints,
            type: LoyaltyTransactionType.REFERRAL_REFERRER,
            reason: 'Récompense parrainage — filleul activé',
          },
        }),
        this.prisma.user.update({
          where: { id: userId },
          data: { loyaltyPoints: { increment: settings.referredBonusPoints } },
        }),
        this.prisma.loyaltyTransaction.create({
          data: {
            userId,
            points: settings.referredBonusPoints,
            type: LoyaltyTransactionType.REFERRAL_REFERRED,
            reason: 'Bonus bienvenue parrainage',
          },
        }),
      ]);
    } catch (error) {
      // Le flag a été posé mais les points n'ont pas été versés : on le rend
      // pour ne pas priver définitivement le filleul de sa récompense.
      await this.prisma.user
        .updateMany({
          where: { id: userId, referralRewarded: true },
          data: { referralRewarded: false },
        })
        .catch(() => undefined);
      throw error;
    }

    this.logger.log(
      `🎁 Parrainage: +${settings.referrerBonusPoints}pts → parrain ${referrer.id}, +${settings.referredBonusPoints}pts → filleul ${userId}`,
    );
  }

  /** Nombre de filleuls déjà récompensés par ce parrain sur 30 jours glissants. */
  private async hasReachedMonthlyCap(referrerId: string): Promise<boolean> {
    const cap = this.maxRewardsPerMonth;
    if (!Number.isFinite(cap) || cap <= 0) return false;

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rewarded = await this.prisma.loyaltyTransaction.count({
      where: {
        userId: referrerId,
        type: LoyaltyTransactionType.REFERRAL_REFERRER,
        createdAt: { gte: since },
      },
    });
    return rewarded >= cap;
  }
}
