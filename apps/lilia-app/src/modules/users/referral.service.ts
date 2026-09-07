import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  LoyaltyTransactionType,
  Prisma,
  ReferralRewardStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { ReferralRewardGrantedEvent } from '../events/loyalty-events';
import {
  ReferralRiskAssessment,
  ReferralRiskService,
} from './referral-risk.service';
import { REFERRAL_RISK_THRESHOLDS } from './referral-risk.config';

/**
 * Récompense de parrainage — versée à la **livraison** de la première commande
 * du filleul.
 *
 * ## Ce qui a changé, et pourquoi (septembre 2026)
 *
 * ### Le déclencheur : `PAYER` → `LIVRER`
 *
 * La récompense tombait à la confirmation du paiement. Or une commande payée
 * reste annulable — par le vendeur depuis `EN_PREPARATION` et `PRET`, par
 * l'administrateur depuis `EN_ROUTE` — avec ouverture d'un remboursement. Le
 * client était remboursé, ses points dépensés lui étaient rendus, et **le point
 * du parrain restait acquis**. `LIVRER` est terminal dans
 * `ORDER_TRANSITION_MATRIX` : le déplacer là supprime la classe entière du
 * problème au lieu d'ajouter une compensation qu'il aurait fallu maintenir.
 *
 * ### La garde : `paidOrderCount === 1` → contrainte d'unicité
 *
 * L'ancienne garde comptait les commandes payées et exigeait le résultat exact
 * `1`. Elle avait deux défauts symétriques et silencieux :
 *
 *  - un filleul sans téléphone était écarté, puis le compteur passait à 2 :
 *    la récompense était perdue **définitivement**, alors que le code affirmait
 *    le contraire ;
 *  - deux paiements confirmés presque simultanément faisaient lire `2` aux deux
 *    appels : **aucune** récompense n'était versée.
 *
 * Elle est remplacée par `ReferralReward.referredUserId @unique`. La base
 * arbitre : la première livraison qui arrive crée la ligne, toute autre reçoit
 * un P2002. « Exactement une », ni zéro ni deux, sans compter quoi que ce soit.
 *
 * ### La décision : un booléen → un statut motivé
 *
 * Une commande livrée ne prouve pas qu'un parrainage est légitime. La commande
 * reste valide dans tous les cas ; la récompense, elle, est arbitrée par
 * `ReferralRiskService` et peut être `APPROVED`, `PENDING_REVIEW` ou
 * `REJECTED` — avec son score et ses signaux figés en base.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly risk: ReferralRiskService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private get maxRewardsPerMonth(): number {
    return Number(
      this.config.get<string>('REFERRAL_MAX_REWARDS_PER_MONTH') ?? 10,
    );
  }

  /**
   * Arbitre la récompense de parrainage à la livraison d'une commande.
   *
   * Appelé sur **les deux** chemins menant à `LIVRER`
   * (`PATCH /orders/:id/status` et `PATCH /deliveries/:id/status`), y compris
   * en concurrence. Non bloquant : un échec ici ne doit jamais empêcher une
   * commande d'être marquée livrée.
   */
  async rewardForDeliveredOrder(
    referredUserId: string,
    orderId: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: referredUserId },
      select: { referredByCode: true, referralRewarded: true },
    });
    if (!user?.referredByCode || user.referralRewarded) return;

    const referrer = await this.prisma.user.findUnique({
      where: { referralCode: user.referredByCode },
      select: { id: true, role: true, statusUser: true },
    });

    // Un compte ne peut pas se parrainer lui-même — impossible à
    // l'inscription (son propre code n'existe pas encore au moment où il
    // saisit celui d'un autre), vérifié ici malgré tout : la garde coûte une
    // comparaison et couvre toute écriture directe en base.
    if (!referrer || referrer.id === referredUserId) return;

    // Un parrain supprimé, banni ou qui n'est pas un client n'encaisse rien.
    if (referrer.statusUser !== 'ACTIVE' || referrer.role !== 'CLIENT') {
      this.logger.warn(
        `REFERRAL_REWARD_REJECTED — parrain ${referrer.id} inéligible (role=${referrer.role}, statut=${referrer.statusUser})`,
      );
      return;
    }

    const assessment = await this.risk.assess(referredUserId, referrer.id);
    const status = await this.applyMonthlyCap(referrer.id, assessment);

    const settings = await this.platformSettings.getSettings();
    const points =
      status === ReferralRewardStatus.APPROVED
        ? settings.referrerBonusPoints
        : 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        // La ligne d'arbitrage vient EN PREMIER : c'est elle qui porte
        // l'unicité, donc c'est elle qui doit faire échouer un doublon avant
        // qu'un solde ne bouge. Même ordre que `LoyaltyService`.
        await tx.referralReward.create({
          data: {
            referrerId: referrer.id,
            referredUserId,
            orderId,
            status,
            riskScore: assessment.score,
            riskSignals: assessment.signals as unknown as Prisma.InputJsonValue,
            points,
          },
        });

        // Le filleul est marqué arbitré quelle qu'ait été la décision : on ne
        // rejoue pas une évaluation à chaque commande suivante.
        await tx.user.update({
          where: { id: referredUserId },
          data: {
            referralRewarded: true,
            referralRewardedAt: new Date(),
            referralRewardOrderId: orderId,
          },
        });

        if (points > 0) {
          await tx.loyaltyTransaction.create({
            data: {
              userId: referrer.id,
              sourceUserId: referredUserId,
              orderId,
              points,
              type: LoyaltyTransactionType.REFERRAL_REFERRER,
              reason: `Parrainage — première commande livrée d'un filleul`,
            },
          });
          await tx.user.update({
            where: { id: referrer.id },
            data: { loyaltyPoints: { increment: points } },
          });
        }
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Course entre les deux chemins vers LIVRER : l'autre a gagné.
        this.logger.log(
          `Parrainage déjà arbitré pour le filleul ${referredUserId} — second appel ignoré`,
        );
        return;
      }
      throw error;
    }

    this.logObservability(
      status,
      assessment,
      referrer.id,
      referredUserId,
      orderId,
    );

    if (points > 0) {
      // Hors transaction : un échec de notification ne doit jamais annuler un
      // crédit de points.
      this.eventEmitter.emit(
        'referral.reward.granted',
        new ReferralRewardGrantedEvent(
          referrer.id,
          referredUserId,
          orderId,
          points,
        ),
      );
    }
  }

  /**
   * Plafond mensuel par parrain — refus **dur**, indépendant du score.
   *
   * Il précède le scoring dans l'ordre de lecture mais s'applique après, pour
   * que la ligne d'arbitrage conserve le score réel : savoir qu'un parrain
   * plafonné était par ailleurs à 0 de risque change la conduite à tenir.
   */
  private async applyMonthlyCap(
    referrerId: string,
    assessment: ReferralRiskAssessment,
  ): Promise<ReferralRewardStatus> {
    const cap = this.maxRewardsPerMonth;
    if (!Number.isFinite(cap) || cap <= 0) return assessment.status;

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rewarded = await this.prisma.referralReward.count({
      where: {
        referrerId,
        status: ReferralRewardStatus.APPROVED,
        decidedAt: { gte: since },
      },
    });

    if (rewarded >= cap) {
      assessment.signals.push({
        code: 'REFERRER_VELOCITY',
        weight: 0, // déjà comptabilisé par le scoring ; ici c'est un refus sec
        detail: `Plafond mensuel atteint (${rewarded}/${cap} sur 30 jours glissants).`,
      });
      return ReferralRewardStatus.PENDING_REVIEW;
    }
    return assessment.status;
  }

  /**
   * Journalisation structurée des décisions (§27 du cahier des charges).
   *
   * Aucune donnée personnelle : des identifiants internes, un score, des codes
   * de signaux. Un administrateur doit pouvoir comprendre **pourquoi** une
   * récompense a été refusée sans ouvrir la base.
   */
  private logObservability(
    status: ReferralRewardStatus,
    assessment: ReferralRiskAssessment,
    referrerId: string,
    referredUserId: string,
    orderId: string,
  ): void {
    const codes = assessment.signals.map((s) => s.code).join(',') || 'none';
    const context = `parrain=${referrerId} filleul=${referredUserId} commande=${orderId} score=${assessment.score} signaux=[${codes}]`;

    switch (status) {
      case ReferralRewardStatus.APPROVED:
        if (assessment.score >= REFERRAL_RISK_THRESHOLDS.WATCH) {
          this.logger.warn(`REFERRAL_RISK_DETECTED — ${context}`);
        }
        this.logger.log(`REFERRAL_REWARD_APPROVED — ${context}`);
        break;
      case ReferralRewardStatus.PENDING_REVIEW:
        this.logger.warn(`REFERRAL_REWARD_PENDING_REVIEW — ${context}`);
        break;
      case ReferralRewardStatus.REJECTED:
        this.logger.warn(`REFERRAL_REWARD_REJECTED — ${context}`);
        break;
    }

    for (const signal of assessment.signals) {
      if (
        signal.code === 'DEVICE_SHARED' ||
        signal.code === 'DEVICE_SAME_REFERRER'
      ) {
        this.logger.warn(
          `REFERRAL_DEVICE_REUSED — ${context} — ${signal.detail}`,
        );
      }
      if (signal.code === 'PHONE_REUSED') {
        this.logger.warn(
          `REFERRAL_PHONE_REUSED — ${context} — ${signal.detail}`,
        );
      }
    }
  }
}
