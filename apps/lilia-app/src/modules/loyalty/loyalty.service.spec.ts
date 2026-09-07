import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LoyaltyTransactionType, Prisma } from '@prisma/client';

import { LoyaltyService } from './loyalty.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * Gain de fidélité — règle forfaitaire (septembre 2026) et garde-fou anti-boucle.
 *
 * Deux propriétés se jouent ici, et aucune n'est cosmétique :
 *
 * 1. **Le forfait.** Une commande livrée vaut le même point, qu'elle pèse
 *    1 000 ou 20 000 XAF. C'est ce qui a remplacé `floor(subTotal/100) × N`.
 * 2. **Le garde-fou.** Une commande qui a consommé des points n'en rapporte
 *    aucun. Sans lui, le forfait crée une machine perpétuelle : un point
 *    achète 50 XAF de nourriture et revient à la livraison, indéfiniment.
 *
 * S'y ajoute l'idempotence héritée du fix M5 : deux chemins mènent à `LIVRER`,
 * et c'est la contrainte `@@unique([orderId, type])` — pas un `if` — qui
 * garantit un seul crédit.
 */
describe('LoyaltyService — forfait, garde-fou anti-boucle, idempotence', () => {
  let service: LoyaltyService;

  const prisma = {
    order: { findUnique: jest.fn() },
    loyaltyTransaction: { create: jest.fn() },
    user: { update: jest.fn() },
    $transaction: jest.fn(),
  };
  const platformSettings = { getSettings: jest.fn() };
  const eventEmitter = { emit: jest.fn() };

  /** Commande livrée n'ayant consommé aucun point — le cas nominal. */
  const orderWithoutPoints = { loyaltyPointsUsed: 0 };

  beforeEach(async () => {
    jest.resetAllMocks();
    platformSettings.getSettings.mockResolvedValue({
      loyaltyPointsPerOrder: 1,
      loyaltyPointValueXaf: 50,
    });
    prisma.order.findUnique.mockResolvedValue(orderWithoutPoints);
    prisma.$transaction.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: prisma },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(LoyaltyService);
  });

  // ─── Le forfait ───────────────────────────────────────────────────────────

  it('crédite exactement 1 point pour une commande livrée', async () => {
    await service.awardForDeliveredOrder('u1', 'o1');

    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        orderId: 'o1',
        points: 1,
        type: LoyaltyTransactionType.ORDER_EARN,
      }),
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { loyaltyPoints: { increment: 1 } },
    });
  });

  it('crédite le même point quel que soit le montant de la commande', async () => {
    // Le montant n'entre plus dans le calcul : le service ne le lit même pas.
    // On le prouve en jouant deux commandes de tailles très différentes et en
    // constatant l'égalité stricte des crédits.
    await service.awardForDeliveredOrder('u1', 'petite-commande');
    await service.awardForDeliveredOrder('u1', 'grosse-commande');

    const credits = prisma.loyaltyTransaction.create.mock.calls.map(
      (call) => (call[0] as { data: { points: number } }).data.points,
    );
    expect(credits).toEqual([1, 1]);
  });

  it('suit le forfait configuré plutôt qu’un 1 écrit en dur', async () => {
    platformSettings.getSettings.mockResolvedValue({
      loyaltyPointsPerOrder: 3,
      loyaltyPointValueXaf: 50,
    });

    await service.awardForDeliveredOrder('u1', 'o1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { loyaltyPoints: { increment: 3 } },
    });
  });

  it('ne crédite rien si le forfait est réglé à 0 (programme désactivé)', async () => {
    platformSettings.getSettings.mockResolvedValue({
      loyaltyPointsPerOrder: 0,
      loyaltyPointValueXaf: 50,
    });

    await service.awardForDeliveredOrder('u1', 'o1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── Le garde-fou anti-boucle ─────────────────────────────────────────────

  it('ne crédite RIEN si la commande a consommé des points', async () => {
    prisma.order.findUnique.mockResolvedValue({ loyaltyPointsUsed: 1 });

    await service.awardForDeliveredOrder('u1', 'o1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  it('ne crédite rien non plus quand la commande a consommé beaucoup de points', async () => {
    prisma.order.findUnique.mockResolvedValue({ loyaltyPointsUsed: 12 });

    await service.awardForDeliveredOrder('u1', 'o1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lit `loyaltyPointsUsed` en base plutôt que de le recevoir en paramètre', async () => {
    // La signature ne l'accepte pas : un appelant ne peut pas se tromper sur
    // une valeur qu'il ne fournit pas. Ce test fige cette propriété.
    await service.awardForDeliveredOrder('u1', 'o1');

    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'o1' },
      select: { loyaltyPointsUsed: true },
    });
    expect(service.awardForDeliveredOrder.length).toBe(2);
  });

  // ─── L'idempotence ────────────────────────────────────────────────────────

  it('écrit la transaction AVANT le solde — c’est elle qui porte la contrainte', async () => {
    await service.awardForDeliveredOrder('u1', 'o1');

    const [operations] = prisma.$transaction.mock.calls[0] as [unknown[]];
    expect(operations).toHaveLength(2);
    // L'ordre importe : si le solde bougeait d'abord, un doublon l'aurait
    // incrémenté avant que la contrainte ne le rejette.
    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledTimes(1);
  });

  it('second appel sur la même commande : P2002 absorbé, aucun double crédit', async () => {
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('doublon', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.awardForDeliveredOrder('u1', 'o1'),
    ).resolves.toBeUndefined();
  });

  it('toute autre erreur remonte (on ne masque pas une panne)', async () => {
    prisma.$transaction.mockRejectedValue(new Error('base injoignable'));

    await expect(service.awardForDeliveredOrder('u1', 'o1')).rejects.toThrow(
      'base injoignable',
    );
  });

  it('n’émet aucune notification quand rien n’a été crédité', async () => {
    prisma.order.findUnique.mockResolvedValue({ loyaltyPointsUsed: 1 });

    await service.awardForDeliveredOrder('u1', 'o1');

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('émet la notification APRÈS le crédit, hors transaction', async () => {
    await service.awardForDeliveredOrder('u1', 'o1');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'loyalty.points.earned',
      expect.objectContaining({
        userId: 'u1',
        orderId: 'o1',
        points: 1,
        // La valeur du point voyage dans l'événement : le libellé du push ne
        // la recalcule pas et ne l'écrit pas en dur.
        pointValueXaf: 50,
      }),
    );
  });

  it('ne crédite rien si la commande est introuvable', async () => {
    prisma.order.findUnique.mockResolvedValue(null);

    await service.awardForDeliveredOrder('u1', 'inconnue');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
