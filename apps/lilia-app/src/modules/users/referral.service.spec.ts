import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  LoyaltyTransactionType,
  Prisma,
  ReferralRewardStatus,
} from '@prisma/client';

import { ReferralService } from './referral.service';
import { ReferralRiskService } from './referral-risk.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * Récompense de parrainage — déclencheur `LIVRER` et arbitrage anti-abus.
 *
 * Ce qui est vérifié ici est exactement ce qui manquait avant :
 *
 *  - la récompense ne tombe plus au paiement, mais à la **livraison** — seul
 *    statut terminal, donc seul moment où elle ne peut plus être défaite ;
 *  - un filleul ne récompense **qu'une fois**, garanti par
 *    `ReferralReward.referredUserId @unique` et non par un comptage ;
 *  - un score de risque élevé retient la récompense **sans** annuler la
 *    commande, qui reste livrée et facturée.
 */
describe('ReferralService — récompense à la livraison', () => {
  let service: ReferralService;

  const tx = {
    referralReward: { create: jest.fn() },
    user: { update: jest.fn() },
    loyaltyTransaction: { create: jest.fn() },
  };

  const prisma = {
    user: { findUnique: jest.fn() },
    referralReward: { count: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const platformSettings = { getSettings: jest.fn() };
  const risk = { assess: jest.fn() };
  const config = { get: jest.fn() };
  const eventEmitter = { emit: jest.fn() };

  const FILLEUL = 'filleul-1';
  const PARRAIN = 'parrain-1';
  const COMMANDE = 'commande-1';

  /** Filleul rattaché à un parrain et pas encore arbitré. */
  function givenPendingReferral() {
    prisma.user.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === FILLEUL) {
        return Promise.resolve({
          referredByCode: 'CODE1234',
          referralRewarded: false,
        });
      }
      if (where.referralCode === 'CODE1234') {
        return Promise.resolve({
          id: PARRAIN,
          role: 'CLIENT',
          statusUser: 'ACTIVE',
        });
      }
      return Promise.resolve(null);
    });
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    platformSettings.getSettings.mockResolvedValue({ referrerBonusPoints: 1 });
    risk.assess.mockResolvedValue({
      score: 0,
      status: ReferralRewardStatus.APPROVED,
      signals: [],
    });
    config.get.mockReturnValue('10');
    prisma.referralReward.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralService,
        { provide: PrismaService, useValue: prisma },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: ReferralRiskService, useValue: risk },
        { provide: ConfigService, useValue: config },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(ReferralService);
  });

  // ─── Le cas nominal ───────────────────────────────────────────────────────

  it('récompense le parrain à la première commande LIVRÉE du filleul', async () => {
    givenPendingReferral();

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(tx.referralReward.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        referrerId: PARRAIN,
        referredUserId: FILLEUL,
        orderId: COMMANDE,
        status: ReferralRewardStatus.APPROVED,
        points: 1,
      }),
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: PARRAIN },
      data: { loyaltyPoints: { increment: 1 } },
    });
  });

  it('le filleul ne reçoit AUCUN point — seul le parrain est récompensé', async () => {
    givenPendingReferral();

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    const credited = tx.loyaltyTransaction.create.mock.calls.map(
      (call) => (call[0] as { data: { userId: string; type: string } }).data,
    );
    expect(credited).toHaveLength(1);
    expect(credited[0].userId).toBe(PARRAIN);
    expect(credited[0].type).toBe(LoyaltyTransactionType.REFERRAL_REFERRER);
    // Le bonus de bienvenue a été supprimé du programme : aucune écriture
    // REFERRAL_REFERRED ne doit plus être produite.
    expect(
      credited.some((c) => c.type === LoyaltyTransactionType.REFERRAL_REFERRED),
    ).toBe(false);
  });

  // ─── La traçabilité ───────────────────────────────────────────────────────

  it('l’écriture nomme le filleul et la commande, pas seulement un motif', async () => {
    givenPendingReferral();

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: PARRAIN,
        // « Quel filleul a généré ce point ? » et « quelle commande ? » ont
        // désormais une réponse en colonne, pas dans une chaîne libre.
        sourceUserId: FILLEUL,
        orderId: COMMANDE,
      }),
    });
  });

  it('date l’arbitrage et retient la commande qualifiante sur le filleul', async () => {
    givenPendingReferral();

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: FILLEUL },
      data: expect.objectContaining({
        referralRewarded: true,
        referralRewardedAt: expect.any(Date),
        referralRewardOrderId: COMMANDE,
      }),
    });
  });

  it('écrit la ligne d’arbitrage AVANT de toucher un solde', async () => {
    givenPendingReferral();
    const order: string[] = [];
    tx.referralReward.create.mockImplementation(() => {
      order.push('reward');
      return Promise.resolve({});
    });
    tx.user.update.mockImplementation(() => {
      order.push('user');
      return Promise.resolve({});
    });

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    // C'est la ligne d'arbitrage qui porte l'unicité : elle doit échouer sur un
    // doublon avant qu'un point ne soit crédité.
    expect(order[0]).toBe('reward');
  });

  // ─── Ce qui ne récompense pas ─────────────────────────────────────────────

  it('ne récompense pas un filleul sans code de parrainage', async () => {
    prisma.user.findUnique.mockResolvedValue({
      referredByCode: null,
      referralRewarded: false,
    });

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne récompense pas deux fois : filleul déjà arbitré', async () => {
    prisma.user.findUnique.mockResolvedValue({
      referredByCode: 'CODE1234',
      referralRewarded: true,
    });

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('en concurrence, le P2002 de la contrainte d’unicité est absorbé', async () => {
    givenPendingReferral();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('doublon', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    // Les deux chemins vers LIVRER peuvent arriver ensemble : le perdant ne
    // doit ni crédit, ni exception.
    await expect(
      service.rewardForDeliveredOrder(FILLEUL, COMMANDE),
    ).resolves.toBeUndefined();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('interdit l’auto-parrainage', async () => {
    prisma.user.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === FILLEUL) {
        return Promise.resolve({
          referredByCode: 'CODE1234',
          referralRewarded: false,
        });
      }
      // Le code renvoie le filleul lui-même.
      return Promise.resolve({
        id: FILLEUL,
        role: 'CLIENT',
        statusUser: 'ACTIVE',
      });
    });

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne récompense pas un parrain banni', async () => {
    prisma.user.findUnique.mockImplementation(({ where }: any) =>
      where.id === FILLEUL
        ? Promise.resolve({
            referredByCode: 'CODE1234',
            referralRewarded: false,
          })
        : Promise.resolve({
            id: PARRAIN,
            role: 'CLIENT',
            statusUser: 'BLOCKED',
          }),
    );

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne récompense pas un parrain qui n’est pas un client', async () => {
    prisma.user.findUnique.mockImplementation(({ where }: any) =>
      where.id === FILLEUL
        ? Promise.resolve({
            referredByCode: 'CODE1234',
            referralRewarded: false,
          })
        : Promise.resolve({
            id: PARRAIN,
            role: 'RESTAURATEUR',
            statusUser: 'ACTIVE',
          }),
    );

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── L'arbitrage anti-abus ────────────────────────────────────────────────

  it('un score en revue enregistre la décision SANS créditer', async () => {
    givenPendingReferral();
    risk.assess.mockResolvedValue({
      score: 65,
      status: ReferralRewardStatus.PENDING_REVIEW,
      signals: [{ code: 'PHONE_REUSED', weight: 65, detail: 'x' }],
    });

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    // La ligne existe — c'est tout l'intérêt : une récompense retenue reste
    // visible et révisable, elle ne disparaît pas.
    expect(tx.referralReward.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: ReferralRewardStatus.PENDING_REVIEW,
        points: 0,
        riskScore: 65,
      }),
    });
    expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('un score de refus enregistre la décision SANS créditer', async () => {
    givenPendingReferral();
    risk.assess.mockResolvedValue({
      score: 110,
      status: ReferralRewardStatus.REJECTED,
      signals: [{ code: 'DEVICE_SAME_REFERRER', weight: 40, detail: 'x' }],
    });

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(tx.referralReward.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: ReferralRewardStatus.REJECTED,
        points: 0,
      }),
    });
    expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  it('fige les signaux de risque en base pour rendre la décision relisible', async () => {
    givenPendingReferral();
    const signals = [
      { code: 'DEVICE_SHARED', weight: 25, detail: '1 autre compte' },
    ];
    risk.assess.mockResolvedValue({
      score: 25,
      status: ReferralRewardStatus.APPROVED,
      signals,
    });

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(tx.referralReward.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ riskSignals: signals }),
    });
  });

  it('un appareil partagé seul ne suffit pas à retenir la récompense', async () => {
    // Cas E du cahier des charges : deux personnes légitimes, même téléphone,
    // numéros différents. Le scoring rend 25 — sous le seuil de revue — donc
    // le service crédite.
    givenPendingReferral();
    risk.assess.mockResolvedValue({
      score: 25,
      status: ReferralRewardStatus.APPROVED,
      signals: [{ code: 'DEVICE_SHARED', weight: 25, detail: 'x' }],
    });

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: PARRAIN },
      data: { loyaltyPoints: { increment: 1 } },
    });
  });

  it('applique le plafond mensuel par parrain, indépendamment du score', async () => {
    givenPendingReferral();
    prisma.referralReward.count.mockResolvedValue(10); // plafond atteint

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(tx.referralReward.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: ReferralRewardStatus.PENDING_REVIEW,
        points: 0,
      }),
    });
  });

  it('un plafond à 0 désactive la limite mensuelle', async () => {
    givenPendingReferral();
    config.get.mockReturnValue('0');
    prisma.referralReward.count.mockResolvedValue(999);

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(tx.referralReward.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: ReferralRewardStatus.APPROVED,
      }),
    });
  });

  // ─── La notification ──────────────────────────────────────────────────────

  it('notifie le parrain hors de la transaction financière', async () => {
    givenPendingReferral();

    await service.rewardForDeliveredOrder(FILLEUL, COMMANDE);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'referral.reward.granted',
      expect.objectContaining({
        referrerId: PARRAIN,
        referredUserId: FILLEUL,
        orderId: COMMANDE,
        points: 1,
      }),
    );
  });
});
