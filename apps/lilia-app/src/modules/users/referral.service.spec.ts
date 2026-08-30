import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LoyaltyTransactionType, OrderStatus } from '@prisma/client';

import { ReferralService } from './referral.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * Fraude au parrainage (fix C3 — audit du 28/08/2026).
 *
 * L'exploit tenait en cinq lignes : créer un compte avec un code de parrain,
 * ajouter n'importe quel produit, valider le panier, **ne jamais payer**.
 * La récompense (+500 pts au parrain, +200 au filleul, 1 pt = 5 XAF) était
 * versée à la création de la commande, et l'expiration au bout de 45 min ne la
 * reprenait pas. 20 comptes = 50 000 XAF de nourriture réelle, gratuite.
 */
describe('ReferralService (C3)', () => {
  let service: ReferralService;

  const prisma = {
    user: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    order: { count: jest.fn() },
    loyaltyTransaction: { count: jest.fn(), create: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  };

  const platformSettings = {
    getSettings: jest.fn().mockResolvedValue({
      referrerBonusPoints: 500,
      referredBonusPoints: 200,
    }),
  };

  const filleul = {
    referredByCode: 'PARRAIN1',
    referralRewarded: false,
    phone: '060000000',
  };

  beforeEach(async () => {
    // `mockReset` et non `clearAllMocks` : il faut vider aussi les files de
    // `mockResolvedValueOnce` non consommées, sinon un test qui sort tôt
    // laisse une valeur en attente pour le suivant.
    jest.resetAllMocks();
    platformSettings.getSettings.mockResolvedValue({
      referrerBonusPoints: 500,
      referredBonusPoints: 200,
    });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyTransaction.count.mockResolvedValue(0);
    prisma.$transaction.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralService,
        { provide: PrismaService, useValue: prisma },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: ConfigService, useValue: { get: () => '10' } },
      ],
    }).compile();

    service = module.get(ReferralService);
  });

  /** Prépare un filleul valide dont le parrain existe. */
  function givenValidReferral(overrides: Partial<typeof filleul> = {}) {
    prisma.user.findUnique
      .mockResolvedValueOnce({ ...filleul, ...overrides }) // le filleul
      .mockResolvedValueOnce({ id: 'parrain-1' }); // le parrain
  }

  it('récompense sur la première commande PAYÉE', async () => {
    givenValidReferral();
    prisma.order.count.mockResolvedValue(1);

    await service.rewardIfFirstPaidOrder('filleul-1');

    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        userId: 'filleul-1',
        status: {
          in: [
            OrderStatus.PAYER,
            OrderStatus.EN_PREPARATION,
            OrderStatus.PRET,
            OrderStatus.EN_ROUTE,
            OrderStatus.LIVRER,
          ],
        },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("ne récompense PAS s'il n'y a aucune commande payée (l'exploit)", async () => {
    givenValidReferral();
    prisma.order.count.mockResolvedValue(0); // commande créée mais jamais payée

    await service.rewardIfFirstPaidOrder('filleul-1');

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne récompense pas deux fois (deuxième commande payée)', async () => {
    givenValidReferral();
    prisma.order.count.mockResolvedValue(2);

    await service.rewardIfFirstPaidOrder('filleul-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne récompense pas un compte déjà récompensé', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      ...filleul,
      referralRewarded: true,
    });

    await service.rewardIfFirstPaidOrder('filleul-1');
    expect(prisma.order.count).not.toHaveBeenCalled();
  });

  it('en concurrence, seul le gagnant du updateMany crédite', async () => {
    givenValidReferral();
    prisma.order.count.mockResolvedValue(1);
    prisma.user.updateMany.mockResolvedValue({ count: 0 }); // un autre est passé avant

    await service.rewardIfFirstPaidOrder('filleul-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('exige un téléphone renseigné (garde anti-ferme-à-comptes)', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ ...filleul, phone: null });

    await service.rewardIfFirstPaidOrder('filleul-1');
    expect(prisma.order.count).not.toHaveBeenCalled();
  });

  it('applique le plafond mensuel par parrain', async () => {
    givenValidReferral();
    prisma.order.count.mockResolvedValue(1);
    prisma.loyaltyTransaction.count.mockResolvedValue(10); // plafond atteint

    await service.rewardIfFirstPaidOrder('filleul-1');

    expect(prisma.loyaltyTransaction.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 'parrain-1',
        type: LoyaltyTransactionType.REFERRAL_REFERRER,
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('interdit l’auto-parrainage', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(filleul)
      .mockResolvedValueOnce({ id: 'filleul-1' }); // le « parrain », c'est lui
    prisma.order.count.mockResolvedValue(1);

    await service.rewardIfFirstPaidOrder('filleul-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rend le flag si le versement échoue (pas de récompense perdue)', async () => {
    givenValidReferral();
    prisma.order.count.mockResolvedValue(1);
    prisma.$transaction.mockRejectedValue(new Error('DB down'));

    await expect(service.rewardIfFirstPaidOrder('filleul-1')).rejects.toThrow(
      'DB down',
    );

    expect(prisma.user.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'filleul-1', referralRewarded: true },
      data: { referralRewarded: false },
    });
  });
});
