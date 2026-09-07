import { Injectable, Logger } from '@nestjs/common';
import { DeviceInstallationStatus, ReferralRewardStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhone } from './phone.util';
import {
  DEVICE_ACCOUNT_FARM_THRESHOLD,
  REFERRAL_RISK_WEIGHTS,
  REFERRER_VELOCITY_THRESHOLD,
  REFERRER_VELOCITY_WINDOW_MS,
  ReferralRiskSignal,
  decideFromScore,
} from './referral-risk.config';

export interface ReferralRiskAssessment {
  score: number;
  status: ReferralRewardStatus;
  signals: ReferralRiskSignal[];
}

/**
 * Évalue le risque d'une récompense de parrainage sur le point d'être versée.
 *
 * ## Ce que ce service décide, et ce qu'il ne décide pas
 *
 * Il décide **si le parrain touche son point**. Il ne bloque aucun compte, ne
 * refuse aucune commande, n'empêche aucune inscription. Cette séparation est le
 * cœur de la conception : le coût d'un faux positif se limite à une récompense
 * qui attend une revue humaine, jamais à un client réel qu'on empêche de
 * commander.
 *
 * ## Pourquoi l'identifiant d'installation n'est jamais suffisant
 *
 * Il est généré par le client, remis à zéro par une désinstallation, et partagé
 * dès qu'un téléphone l'est. S'en servir comme preuve d'identité produirait des
 * refus sur des familles entières. Il ne fait donc que **pondérer** : partagé,
 * il vaut 25 points de risque, soit moitié moins que le seuil de revue.
 *
 * ## Lecture seule
 *
 * Aucune écriture ici. Le service calcule, `ReferralService` décide de la suite
 * et écrit — pour qu'un changement de barème de risque ne puisse jamais, par
 * inadvertance, modifier un solde.
 */
@Injectable()
export class ReferralRiskService {
  private readonly logger = new Logger(ReferralRiskService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param referredUserId  le filleul dont la première commande vient d'être livrée
   * @param referrerId      le parrain qui recevrait le point
   */
  async assess(
    referredUserId: string,
    referrerId: string,
  ): Promise<ReferralRiskAssessment> {
    const signals: ReferralRiskSignal[] = [];

    const referred = await this.prisma.user.findUnique({
      where: { id: referredUserId },
      select: { id: true, phone: true },
    });

    // Les installations depuis lesquelles CE filleul s'est connecté.
    const installations = await this.prisma.deviceInstallation.findMany({
      where: { userId: referredUserId },
      select: { installationId: true, status: true },
    });
    const installationIds = installations.map((i) => i.installationId);

    await this.checkBlockedDevice(installations, signals);
    await this.checkPhone(referred?.phone ?? null, referredUserId, signals);
    await this.checkDeviceSharing(
      installationIds,
      referredUserId,
      referrerId,
      signals,
    );
    await this.checkReferrerVelocity(referrerId, signals);

    const score = Math.min(
      100,
      signals.reduce((sum, s) => sum + s.weight, 0),
    );
    const status = decideFromScore(score);

    return { score, status, signals };
  }

  /** Une installation bannie à la main ne produit plus aucune récompense. */
  private async checkBlockedDevice(
    installations: { status: DeviceInstallationStatus }[],
    signals: ReferralRiskSignal[],
  ): Promise<void> {
    if (
      installations.some((i) => i.status === DeviceInstallationStatus.BLOCKED)
    ) {
      signals.push({
        code: 'DEVICE_BLOCKED',
        weight: REFERRAL_RISK_WEIGHTS.DEVICE_BLOCKED,
        detail: 'Installation bloquée par un administrateur.',
      });
    }
  }

  /**
   * Signal 2 et 3 — le téléphone.
   *
   * On compare sur la forme **normalisée** : `06 123 45 67`, `+242 06 1234567`
   * et `242061234567` sont le même numéro, et un fraudeur n'a aucune raison de
   * les saisir à l'identique.
   */
  private async checkPhone(
    rawPhone: string | null,
    referredUserId: string,
    signals: ReferralRiskSignal[],
  ): Promise<void> {
    const phone = normalizePhone(rawPhone);

    if (!phone) {
      signals.push({
        code: 'NO_PHONE',
        weight: REFERRAL_RISK_WEIGHTS.NO_PHONE,
        detail: 'Aucun numéro de téléphone renseigné sur le compte filleul.',
      });
      return;
    }

    // `phone` est stocké tel que saisi ; on compare donc les variantes connues
    // plutôt que d'exiger une colonne normalisée (qui imposerait une migration
    // de données sur un champ que l'utilisateur peut modifier à tout moment).
    const candidates = await this.prisma.user.findMany({
      where: {
        id: { not: referredUserId },
        phone: { not: null },
      },
      select: { id: true, phone: true },
      // Borne de sûreté : ce n'est pas une recherche exhaustive, c'est un
      // signal. Au-delà, la base a un problème plus grave que ce parrainage.
      take: 5000,
    });

    const collisions = candidates.filter(
      (c) => normalizePhone(c.phone) === phone,
    );

    if (collisions.length > 0) {
      signals.push({
        code: 'PHONE_REUSED',
        weight: REFERRAL_RISK_WEIGHTS.PHONE_REUSED,
        detail: `Numéro déjà porté par ${collisions.length} autre(s) compte(s).`,
      });
    }
  }

  /** Signaux 1, 4 et 5 — l'appareil. */
  private async checkDeviceSharing(
    installationIds: string[],
    referredUserId: string,
    referrerId: string,
    signals: ReferralRiskSignal[],
  ): Promise<void> {
    if (installationIds.length === 0) {
      // Aucune installation connue (vieille version de l'app, appel direct de
      // l'API). Signal absent, pas signal négatif : on n'invente pas un risque
      // à partir d'une donnée manquante, et on n'en absout pas non plus.
      return;
    }

    // Signal 1 & 4 — les autres comptes nés du même appareil.
    const siblings = await this.prisma.deviceInstallation.findMany({
      where: {
        installationId: { in: installationIds },
        userId: { not: referredUserId },
      },
      select: { userId: true },
      distinct: ['userId'],
    });

    if (siblings.length > 0) {
      const weight = Math.min(
        REFERRAL_RISK_WEIGHTS.DEVICE_SHARED_MAX,
        siblings.length * REFERRAL_RISK_WEIGHTS.DEVICE_SHARED_PER_ACCOUNT,
      );
      signals.push({
        code: 'DEVICE_SHARED',
        weight,
        detail: `${siblings.length} autre(s) compte(s) sur la même installation.`,
      });
    }

    // +1 : le filleul lui-même.
    if (siblings.length + 1 >= DEVICE_ACCOUNT_FARM_THRESHOLD) {
      signals.push({
        code: 'DEVICE_ACCOUNT_FARM',
        weight: REFERRAL_RISK_WEIGHTS.DEVICE_ACCOUNT_FARM,
        detail: `${siblings.length + 1} comptes créés depuis cette installation (seuil ${DEVICE_ACCOUNT_FARM_THRESHOLD}).`,
      });
    }

    // Signal 5 — le cluster : cet appareil a DÉJÀ converti un filleul pour CE
    // parrain. C'est la signature du scénario « un téléphone, un code, des
    // comptes en série » ; c'est aussi le seul signal qui relie l'appareil au
    // bénéficiaire, donc le plus difficile à produire par hasard.
    if (siblings.length > 0) {
      const priorRewards = await this.prisma.referralReward.count({
        where: {
          referrerId,
          referredUserId: { in: siblings.map((s) => s.userId) },
          status: {
            in: [
              ReferralRewardStatus.APPROVED,
              ReferralRewardStatus.PENDING_REVIEW,
            ],
          },
        },
      });

      if (priorRewards > 0) {
        signals.push({
          code: 'DEVICE_SAME_REFERRER',
          weight: REFERRAL_RISK_WEIGHTS.DEVICE_SAME_REFERRER,
          detail: `${priorRewards} filleul(s) du même parrain déjà converti(s) depuis cette installation.`,
        });
      }
    }
  }

  /** Signal 6 — cadence anormale côté parrain. */
  private async checkReferrerVelocity(
    referrerId: string,
    signals: ReferralRiskSignal[],
  ): Promise<void> {
    const since = new Date(Date.now() - REFERRER_VELOCITY_WINDOW_MS);
    const recent = await this.prisma.referralReward.count({
      where: {
        referrerId,
        status: ReferralRewardStatus.APPROVED,
        decidedAt: { gte: since },
      },
    });

    if (recent >= REFERRER_VELOCITY_THRESHOLD) {
      signals.push({
        code: 'REFERRER_VELOCITY',
        weight: REFERRAL_RISK_WEIGHTS.REFERRER_VELOCITY,
        detail: `${recent} récompenses versées à ce parrain sur les dernières 24 h.`,
      });
    }
  }
}
