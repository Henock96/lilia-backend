import { Test, TestingModule } from '@nestjs/testing';
import { LoyaltyTransactionType, Prisma } from '@prisma/client';

import { LoyaltyService } from './loyalty.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * Double crédit de points de fidélité (fix M5 — audit du 28/08/2026).
 *
 * Deux chemins mènent une commande à `LIVRER` — `PATCH /orders/:id/status` et
 * `PATCH /deliveries/:id/status` — et chacun portait sa propre copie de
 * `awardLoyaltyPoints`, sans écriture conditionnelle. Joués en concurrence, ils
 * créditaient deux fois, et aucune contrainte de base ne s'y opposait.
 */
describe('LoyaltyService (M5)', () => {
  let service: LoyaltyService;

  const prisma = {
    loyaltyTransaction: { create: jest.fn() },
    user: { update: jest.fn() },
    $transaction: jest.fn(),
  };
  const platformSettings = {
    getSettings: jest.fn().mockResolvedValue({ loyaltyPointsPer100Xaf: 1 }),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    platformSettings.getSettings.mockResolvedValue({
      loyaltyPointsPer100Xaf: 1,
    });
    prisma.$transaction.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: prisma },
        { provide: PlatformSettingsService, useValue: platformSettings },
      ],
    }).compile();

    service = module.get(LoyaltyService);
  });

  it('crédite 1 pt par 100 XAF de sous-total', async () => {
    await service.awardForDeliveredOrder('u1', 'o1', 4500);

    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        orderId: 'o1',
        points: 45,
        type: LoyaltyTransactionType.ORDER_EARN,
      }),
    });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('écrit la transaction AVANT le solde — c’est elle qui porte la contrainte', async () => {
    await service.awardForDeliveredOrder('u1', 'o1', 1000);

    // L'ordre du tableau passé à $transaction détermine l'ordre SQL : si le
    // solde bougeait en premier, un doublon l'aurait incrémenté avant d'être
    // rejeté.
    const ops = prisma.$transaction.mock.calls[0][0];
    expect(
      prisma.loyaltyTransaction.create.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.user.update.mock.invocationCallOrder[0]);
    expect(ops).toHaveLength(2);
  });

  it('second appel sur la même commande : P2002 absorbé, aucun double crédit', async () => {
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.10.0',
      }),
    );

    await expect(
      service.awardForDeliveredOrder('u1', 'o1', 4500),
    ).resolves.toBeUndefined();
  });

  it('toute autre erreur remonte (on ne masque pas une panne)', async () => {
    prisma.$transaction.mockRejectedValue(new Error('DB down'));

    await expect(
      service.awardForDeliveredOrder('u1', 'o1', 4500),
    ).rejects.toThrow('DB down');
  });

  it('ne crédite rien sous 100 XAF', async () => {
    await service.awardForDeliveredOrder('u1', 'o1', 50);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
