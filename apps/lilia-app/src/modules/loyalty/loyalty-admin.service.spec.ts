import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { LoyaltyTransactionType, ReferralRewardStatus } from '@prisma/client';

import { LoyaltyAdminService } from './loyalty-admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';

/**
 * Écritures d'administration sur la fidélité.
 *
 * Deux propriétés se jouent ici : **aucun solde ne bouge sans nom**, et le
 * ledger accompagne toujours le solde. La seconde est l'invariant que la
 * réconciliation quotidienne contrôle — le casser depuis l'outil
 * d'administration serait particulièrement ironique.
 */
describe('LoyaltyAdminService', () => {
  let service: LoyaltyAdminService;

  const tx = {
    $executeRaw: jest.fn(),
    user: { update: jest.fn(), findUniqueOrThrow: jest.fn() },
    loyaltyTransaction: { create: jest.fn() },
    referralReward: { updateMany: jest.fn() },
  };

  const prisma = {
    user: { findUnique: jest.fn() },
    referralReward: { findUnique: jest.fn() },
    platformSettings: { findUnique: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    prisma.user.findUnique.mockResolvedValue({ id: 'c1', loyaltyPoints: 10 });
    tx.user.findUniqueOrThrow.mockResolvedValue({ loyaltyPoints: 15 });
    tx.$executeRaw.mockResolvedValue(1);
    prisma.platformSettings.findUnique.mockResolvedValue({
      referrerBonusPoints: 1,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoyaltyAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminAuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(LoyaltyAdminService);
  });

  // ─── Ajustement manuel ────────────────────────────────────────────────────

  describe('adjust', () => {
    it('crédite et écrit une ligne de ledger nominative', async () => {
      const result = await service.adjust({
        actorId: 'admin-1',
        userId: 'c1',
        points: 5,
        reason: 'Geste commercial commande #A1B2C3',
      });

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { loyaltyPoints: { increment: 5 } },
      });
      expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'c1',
          // Sans `actorId`, un solde pourrait bouger sans qu'on sache qui l'a
          // décidé — c'est exactement ce qu'on cherche à rendre impossible.
          actorId: 'admin-1',
          points: 5,
          type: LoyaltyTransactionType.ADJUSTMENT,
        }),
      });
      expect(result.balance).toBe(15);
    });

    it('double la trace dans le journal d’audit', async () => {
      await service.adjust({
        actorId: 'admin-1',
        userId: 'c1',
        points: 5,
        reason: 'Geste commercial',
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          action: 'LOYALTY_ADJUSTED',
          targetId: 'c1',
          metadata: expect.objectContaining({
            points: 5,
            balanceBefore: 10,
            balanceAfter: 15,
          }),
        }),
      );
    });

    it('débite par une écriture CONDITIONNELLE — jamais de solde négatif', async () => {
      await service.adjust({
        actorId: 'admin-1',
        userId: 'c1',
        points: -3,
        reason: 'Correction de crédit erroné',
      });

      // Le décrément passe par du SQL conditionné (`WHERE loyaltyPoints >= n`),
      // pas par un `decrement` Prisma : c'est la base qui refuse de descendre
      // sous zéro, comme au checkout.
      expect(tx.$executeRaw).toHaveBeenCalled();
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('refuse un débit supérieur au solde (409)', async () => {
      tx.$executeRaw.mockResolvedValue(0); // aucune ligne affectée

      await expect(
        service.adjust({
          actorId: 'admin-1',
          userId: 'c1',
          points: -999,
          reason: 'Tentative de débit excessif',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('refuse un ajustement nul', async () => {
      await expect(
        service.adjust({
          actorId: 'admin-1',
          userId: 'c1',
          points: 0,
          reason: 'Sans effet',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuse un ajustement non entier', async () => {
      await expect(
        service.adjust({
          actorId: 'admin-1',
          userId: 'c1',
          points: 1.5,
          reason: 'Un demi-point n’existe pas',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('borne l’ajustement manuel', async () => {
      // Un garde-fou de bon sens : au-delà, c'est une décision qui mérite une
      // trace ailleurs que dans un champ de formulaire.
      await expect(
        service.adjust({
          actorId: 'admin-1',
          userId: 'c1',
          points: 100000,
          reason: 'Erreur de saisie probable',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('exige un motif', async () => {
      await expect(
        service.adjust({
          actorId: 'admin-1',
          userId: 'c1',
          points: 5,
          reason: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── Revue d'une récompense de parrainage ─────────────────────────────────

  describe('reviewReferralReward', () => {
    const pendingReward = {
      id: 'r1',
      status: ReferralRewardStatus.PENDING_REVIEW,
      referrerId: 'parrain-1',
      referredUserId: 'filleul-1',
      orderId: 'commande-1',
      riskScore: 65,
    };

    beforeEach(() => {
      prisma.referralReward.findUnique.mockResolvedValue(pendingReward);
      tx.referralReward.updateMany.mockResolvedValue({ count: 1 });
    });

    it('approuve : crédite le parrain et trace le filleul', async () => {
      await service.reviewReferralReward({
        actorId: 'admin-1',
        rewardId: 'r1',
        decision: 'APPROVE',
      });

      expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'parrain-1',
          sourceUserId: 'filleul-1',
          orderId: 'commande-1',
          actorId: 'admin-1',
          points: 1,
        }),
      });
    });

    it('refuse : aucun point versé, décision conservée', async () => {
      await service.reviewReferralReward({
        actorId: 'admin-1',
        rewardId: 'r1',
        decision: 'REJECT',
        note: 'Cinq comptes sur le même appareil',
      });

      expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled();
      expect(tx.referralReward.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ReferralRewardStatus.REJECTED,
            points: 0,
            reviewNote: 'Cinq comptes sur le même appareil',
          }),
        }),
      );
    });

    it('conditionne l’écriture sur PENDING_REVIEW — deux admins simultanés ne créditent pas deux fois', async () => {
      await service.reviewReferralReward({
        actorId: 'admin-1',
        rewardId: 'r1',
        decision: 'APPROVE',
      });

      expect(tx.referralReward.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'r1', status: ReferralRewardStatus.PENDING_REVIEW },
        }),
      );
    });

    it('lève 409 si un autre administrateur a arbitré entre-temps', async () => {
      tx.referralReward.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reviewReferralReward({
          actorId: 'admin-1',
          rewardId: 'r1',
          decision: 'APPROVE',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('refuse de rejouer une récompense déjà approuvée', async () => {
      // Rejouer une approbation doublerait un crédit déjà passé.
      prisma.referralReward.findUnique.mockResolvedValue({
        ...pendingReward,
        status: ReferralRewardStatus.APPROVED,
      });

      await expect(
        service.reviewReferralReward({
          actorId: 'admin-1',
          rewardId: 'r1',
          decision: 'APPROVE',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('refuse de revenir sur un refus motivé', async () => {
      prisma.referralReward.findUnique.mockResolvedValue({
        ...pendingReward,
        status: ReferralRewardStatus.REJECTED,
      });

      await expect(
        service.reviewReferralReward({
          actorId: 'admin-1',
          rewardId: 'r1',
          decision: 'APPROVE',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('journalise l’arbitrage', async () => {
      await service.reviewReferralReward({
        actorId: 'admin-1',
        rewardId: 'r1',
        decision: 'APPROVE',
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REFERRAL_REWARD_REVIEWED',
          actorId: 'admin-1',
          metadata: expect.objectContaining({
            rewardId: 'r1',
            decision: 'APPROVE',
            riskScore: 65,
          }),
        }),
      );
    });
  });
});
