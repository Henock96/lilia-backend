import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LoyaltyTransactionType, ReferralRewardStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';

/** Borne de sûreté sur une écriture manuelle, dans les deux sens. */
const MAX_MANUAL_ADJUSTMENT = 1000;

/**
 * Écritures d'administration sur la fidélité.
 *
 * ## Pourquoi ce service existe
 *
 * Jusqu'en septembre 2026, **aucun** moyen ne permettait de corriger un solde.
 * `LoyaltyTransactionType.ADJUSTMENT` existait dans l'enum mais aucun code ne
 * l'écrivait : une erreur de crédit ne pouvait être réparée que par une
 * requête SQL manuelle — invisible, non datée, sans auteur, et qui aurait mis
 * le compte en dérive au contrôle du lendemain.
 *
 * ## Les deux règles
 *
 * 1. **Aucun solde ne bouge sans nom.** Chaque écriture porte son `actorId`,
 *    son motif, et double la trace dans `AdminAuditLog`. Un point vaut de
 *    l'argent : le créditer à la main est un mouvement financier, pas un
 *    réglage.
 * 2. **Le ledger et le solde bougent ensemble, dans une transaction.** C'est
 *    l'invariant que `LoyaltyReconciliationService` vérifie chaque nuit ; le
 *    casser depuis l'outil d'administration serait particulièrement ironique.
 */
@Injectable()
export class LoyaltyAdminService {
  private readonly logger = new Logger(LoyaltyAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Crédite (`points > 0`) ou débite (`points < 0`) le solde d'un client.
   *
   * Un débit ne peut pas rendre le solde négatif : le décrément est conditionné
   * en base, comme au checkout. Un solde négatif serait une dette envers la
   * plateforme, notion qui n'existe pas dans le programme.
   */
  async adjust(params: {
    actorId: string;
    userId: string;
    points: number;
    reason: string;
  }) {
    const { actorId, userId, points, reason } = params;

    if (!Number.isInteger(points) || points === 0) {
      throw new BadRequestException(
        'Le nombre de points doit être un entier non nul.',
      );
    }
    if (Math.abs(points) > MAX_MANUAL_ADJUSTMENT) {
      throw new BadRequestException(
        `Un ajustement manuel est borné à ${MAX_MANUAL_ADJUSTMENT} points. Au-delà, passer par une décision documentée hors interface.`,
      );
    }
    if (!reason?.trim()) {
      throw new BadRequestException(
        "Un motif est obligatoire : c'est lui qui rend l'écriture relisible.",
      );
    }

    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, loyaltyPoints: true },
    });
    if (!target) throw new NotFoundException('Client introuvable.');

    const balanceAfter = await this.prisma.$transaction(async (tx) => {
      if (points < 0) {
        // Décrément conditionnel — même garde qu'au checkout : la base refuse
        // de descendre sous zéro, on ne se fie pas au solde lu au-dessus.
        const rows = await tx.$executeRaw`
          UPDATE "User"
          SET "loyaltyPoints" = "loyaltyPoints" - ${Math.abs(points)}
          WHERE id = ${userId} AND "loyaltyPoints" >= ${Math.abs(points)}
        `;
        if (rows === 0) {
          throw new ConflictException(
            `Solde insuffisant : ${target.loyaltyPoints} point(s) disponible(s).`,
          );
        }
      } else {
        await tx.user.update({
          where: { id: userId },
          data: { loyaltyPoints: { increment: points } },
        });
      }

      await tx.loyaltyTransaction.create({
        data: {
          userId,
          actorId,
          points,
          type: LoyaltyTransactionType.ADJUSTMENT,
          reason: reason.trim(),
        },
      });

      const updated = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { loyaltyPoints: true },
      });
      return updated.loyaltyPoints;
    });

    await this.audit.record({
      actorId,
      action: 'LOYALTY_ADJUSTED',
      targetType: 'User',
      targetId: userId,
      reason: reason.trim(),
      metadata: {
        points,
        balanceBefore: target.loyaltyPoints,
        balanceAfter,
      },
    });

    this.logger.log(
      `LOYALTY_ADJUSTED — admin=${actorId} client=${userId} points=${points} solde=${target.loyaltyPoints}→${balanceAfter}`,
    );

    return { balance: balanceAfter, points, reason: reason.trim() };
  }

  /** File d'attente des récompenses retenues par le scoring anti-abus. */
  async listReferralRewards(params: {
    status?: ReferralRewardStatus;
    page?: number;
    limit?: number;
  }) {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 20, 100);

    const where = params.status ? { status: params.status } : {};

    const [rewards, total] = await this.prisma.$transaction([
      this.prisma.referralReward.findMany({
        where,
        orderBy: { decidedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          riskScore: true,
          riskSignals: true,
          points: true,
          decidedAt: true,
          reviewedAt: true,
          reviewNote: true,
          orderId: true,
          // Minimisation : de quoi identifier et rappeler, jamais l'e-mail.
          referrer: { select: { id: true, nom: true, phone: true } },
          referredUser: { select: { id: true, nom: true, phone: true } },
        },
      }),
      this.prisma.referralReward.count({ where }),
    ]);

    return { data: rewards, meta: { total, page, limit } };
  }

  /**
   * Arbitrage humain d'une récompense `PENDING_REVIEW`.
   *
   * Seul ce statut est révisable : approuver un `REJECTED` reviendrait à
   * contourner une décision motivée sans la rouvrir, et rejouer un `APPROVED`
   * doublerait un crédit déjà passé.
   */
  async reviewReferralReward(params: {
    actorId: string;
    rewardId: string;
    decision: 'APPROVE' | 'REJECT';
    note?: string;
  }) {
    const { actorId, rewardId, decision, note } = params;

    const reward = await this.prisma.referralReward.findUnique({
      where: { id: rewardId },
      include: { referrer: { select: { id: true } } },
    });
    if (!reward) throw new NotFoundException('Récompense introuvable.');
    if (reward.status !== ReferralRewardStatus.PENDING_REVIEW) {
      throw new ConflictException(
        `Cette récompense est déjà ${reward.status === ReferralRewardStatus.APPROVED ? 'approuvée' : 'refusée'} — elle n'est plus révisable.`,
      );
    }

    const settings = await this.prisma.platformSettings.findUnique({
      where: { id: 'singleton' },
      select: { referrerBonusPoints: true },
    });
    const points =
      decision === 'APPROVE' ? (settings?.referrerBonusPoints ?? 1) : 0;

    await this.prisma.$transaction(async (tx) => {
      // Conditionné sur PENDING_REVIEW : deux administrateurs qui cliquent en
      // même temps ne créditent pas deux fois.
      const claimed = await tx.referralReward.updateMany({
        where: { id: rewardId, status: ReferralRewardStatus.PENDING_REVIEW },
        data: {
          status:
            decision === 'APPROVE'
              ? ReferralRewardStatus.APPROVED
              : ReferralRewardStatus.REJECTED,
          points,
          reviewedById: actorId,
          reviewedAt: new Date(),
          reviewNote: note?.trim() ?? null,
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'Cette récompense vient d’être arbitrée par quelqu’un d’autre.',
        );
      }

      if (points > 0) {
        await tx.loyaltyTransaction.create({
          data: {
            userId: reward.referrerId,
            sourceUserId: reward.referredUserId,
            orderId: reward.orderId,
            actorId,
            points,
            type: LoyaltyTransactionType.REFERRAL_REFERRER,
            reason: 'Parrainage — approuvé après revue',
          },
        });
        await tx.user.update({
          where: { id: reward.referrerId },
          data: { loyaltyPoints: { increment: points } },
        });
      }
    });

    await this.audit.record({
      actorId,
      action: 'REFERRAL_REWARD_REVIEWED',
      targetType: 'User',
      targetId: reward.referrerId,
      reason: note?.trim() ?? null,
      metadata: {
        rewardId,
        decision,
        points,
        riskScore: reward.riskScore,
        referredUserId: reward.referredUserId,
        orderId: reward.orderId,
      },
    });

    this.logger.log(
      `REFERRAL_REWARD_REVIEWED — admin=${actorId} récompense=${rewardId} décision=${decision} points=${points}`,
    );

    return { id: rewardId, decision, points };
  }
}
