import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';

import { DriverSettlementService } from './driver-settlement.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Règlement du livreur — ce que Lilia Food lui a versé.
 *
 * ## Les deux façons de se tromper, et ce qui les empêche
 *
 * **Payer deux fois la même course.** `Delivery.driverSettlementId` l'interdit,
 * et c'est la BASE qui arbitre : le rattachement passe par un
 * `updateMany WHERE driverSettlementId IS NULL`. Si le compte rattaché ne
 * correspond pas à ce qui était prévu, la transaction est annulée. Un contrôle
 * applicatif (`if (déjà réglé)`) serait un read-then-write, donc franchissable
 * par deux administrateurs simultanés.
 *
 * **Sous-payer en silence.** Entre l'instant où l'administrateur lit « 3 500
 * XAF » et celui où il enregistre le règlement, le livreur peut terminer deux
 * courses. Absorber ces courses dans un montant déjà convenu et déjà remis le
 * sous-paierait sans que rien ne le signale. D'où `coveredUntil`, **fourni par
 * l'appelant** : aucune course livrée après cette coupure n'entre.
 */
describe('DriverSettlementService', () => {
  let service: DriverSettlementService;

  const tx = {
    delivery: { updateMany: jest.fn(), findMany: jest.fn() },
    driverSettlement: { create: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    user: { findUnique: jest.fn() },
    delivery: { findMany: jest.fn(), updateMany: jest.fn() },
    driverSettlement: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };

  const DRIVER = { id: 'liv1', role: 'LIVREUR' };
  const CUTOFF = new Date('2026-09-19T12:00:00Z');

  /** Courses livrées, économie gelée, non encore réglées. */
  const course = (id: string, pay: number, deliveredAt: string) => ({
    id,
    driverPayXaf: pay,
    deliveredAt: new Date(deliveredAt),
    driverEconomicsFrozenAt: new Date(deliveredAt),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(DRIVER);
    tx.driverSettlement.create.mockImplementation(async (args: any) => ({
      id: 'set-1',
      ...args.data,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriverSettlementService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(DriverSettlementService);
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('outstanding — une LECTURE, qui ne verrouille rien', () => {
    it('somme les courses gelées et non réglées', async () => {
      prisma.delivery.findMany.mockResolvedValue([
        course('d1', 350, '2026-09-18T10:00:00Z'),
        course('d2', 650, '2026-09-18T14:00:00Z'),
      ]);

      const result = await service.getOutstanding('liv1', CUTOFF);

      expect(result.amountXaf).toBe(1000);
      expect(result.courseCount).toBe(2);
      expect(result.coveredUntil).toEqual(CUTOFF);
    });

    it('n’écrit RIEN — c’est ce qui la distingue d’un compte arrêté', async () => {
      prisma.delivery.findMany.mockResolvedValue([
        course('d1', 350, '2026-09-18T10:00:00Z'),
      ]);

      await service.getOutstanding('liv1', CUTOFF);

      // Un `PENDING` aurait rendu le même service en posant un verrou, et un
      // administrateur interrompu aurait bloqué les courses de ce livreur.
      expect(prisma.delivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.driverSettlement.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ne retient que les courses livrées AVANT la coupure', async () => {
      prisma.delivery.findMany.mockResolvedValue([]);

      await service.getOutstanding('liv1', CUTOFF);

      const where = prisma.delivery.findMany.mock.calls[0][0].where;
      expect(where.delivererId).toBe('liv1');
      expect(where.status).toBe('LIVRER');
      expect(where.driverSettlementId).toBeNull();
      // Le gel est exigé : une course sans économie n'a pas de montant dû.
      expect(where.driverEconomicsFrozenAt).toEqual({ not: null });
      expect(where.deliveredAt).toEqual({ lte: CUTOFF });
    });

    it('rien à régler → 0 course et 0 XAF, sans erreur', async () => {
      prisma.delivery.findMany.mockResolvedValue([]);

      const result = await service.getOutstanding('liv1', CUTOFF);

      expect(result).toMatchObject({ amountXaf: 0, courseCount: 0 });
    });

    it('refuse un utilisateur qui n’est pas livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });

      await expect(service.getOutstanding('u1', CUTOFF)).rejects.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('record — enregistre un règlement DÉJÀ payé', () => {
    const input = {
      driverId: 'liv1',
      coveredUntil: CUTOFF,
      method: 'CASH' as const,
      adminId: 'admin-1',
    };

    beforeEach(() => {
      prisma.delivery.findMany.mockResolvedValue([
        course('d1', 350, '2026-09-18T10:00:00Z'),
        course('d2', 650, '2026-09-18T14:00:00Z'),
      ]);
      tx.delivery.updateMany.mockResolvedValue({ count: 2 });
    });

    it('fige le montant, le nombre de courses et la période', async () => {
      await service.record(input);

      expect(tx.driverSettlement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            driverId: 'liv1',
            amountXaf: 1000,
            courseCount: 2,
            periodStart: new Date('2026-09-18T10:00:00Z'),
            coveredUntil: CUTOFF,
            method: 'CASH',
            status: 'PAID',
            recordedBy: 'admin-1',
          }),
        }),
      );
    });

    it('rattache les courses avec un verrou sur « non encore réglée »', async () => {
      await service.record(input);

      const args = tx.delivery.updateMany.mock.calls[0][0];
      // `driverSettlementId: null` dans le WHERE : c'est la base qui refuse
      // qu'une course déjà couverte soit rattachée une seconde fois.
      expect(args.where).toMatchObject({
        id: { in: ['d1', 'd2'] },
        driverSettlementId: null,
      });
      expect(args.data).toEqual({ driverSettlementId: 'set-1' });
    });

    it('course raflée entre-temps : la transaction échoue, rien n’est écrit', async () => {
      // Un autre administrateur a réglé `d2` pendant ce temps : seule `d1` est
      // rattachée. Le montant remis couvrait pourtant les deux.
      tx.delivery.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.record(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuse d’enregistrer un règlement sans aucune course', async () => {
      // Sans ce refus, on créerait une pièce comptable à 0 XAF couvrant rien —
      // et deux clics répétés en produiraient une collection.
      prisma.delivery.findMany.mockResolvedValue([]);

      await expect(service.record(input)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.driverSettlement.create).not.toHaveBeenCalled();
    });

    it('le montant figé est EXACTEMENT la somme des courses couvertes', async () => {
      prisma.delivery.findMany.mockResolvedValue([
        course('d1', 117, '2026-09-18T10:00:00Z'),
        course('d2', 216, '2026-09-18T11:00:00Z'),
        course('d3', 0, '2026-09-18T12:00:00Z'), // livreur au salaire
      ]);
      tx.delivery.updateMany.mockResolvedValue({ count: 3 });

      await service.record(input);

      const data = tx.driverSettlement.create.mock.calls[0][0].data;
      expect(data.amountXaf).toBe(333);
      expect(data.courseCount).toBe(3);
    });

    it('`paidAt` par défaut = maintenant, mais reste fournissable', async () => {
      // Un règlement d'hier saisi ce matin doit porter la date d'hier, sinon
      // toute lecture par période est fausse.
      const hier = new Date('2026-09-18T18:00:00Z');
      await service.record({ ...input, paidAt: hier });

      expect(tx.driverSettlement.create.mock.calls[0][0].data.paidAt).toEqual(
        hier,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('cancel — la saisie erronée, pas un flux', () => {
    it('libère les courses et marque le règlement annulé', async () => {
      prisma.driverSettlement.findUnique.mockResolvedValue({
        id: 'set-1',
        status: 'PAID',
      });
      tx.delivery.updateMany.mockResolvedValue({ count: 2 });
      tx.driverSettlement.update.mockResolvedValue({
        id: 'set-1',
        status: 'CANCELLED',
      });

      await service.cancel('set-1', 'admin-1', 'Montant erroné');

      // Les courses redeviennent réglables : sans cela, annuler une saisie
      // rendrait la dette impayable.
      expect(tx.delivery.updateMany).toHaveBeenCalledWith({
        where: { driverSettlementId: 'set-1' },
        data: { driverSettlementId: null },
      });
      expect(tx.driverSettlement.update.mock.calls[0][0].data).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'admin-1',
        cancelReason: 'Montant erroné',
      });
    });

    it('refuse d’annuler deux fois', async () => {
      prisma.driverSettlement.findUnique.mockResolvedValue({
        id: 'set-1',
        status: 'CANCELLED',
      });

      await expect(
        service.cancel('set-1', 'admin-1', 'x'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
