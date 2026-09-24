import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DeliveryTariffsService,
  tariffDraftViolations,
} from './delivery-tariffs.service';

/**
 * Grille de livraison versionnée (F3-02).
 *
 * Une version publiée est IMMUABLE : les commandes figent son numéro, et
 * relire une grille modifiée après coup ferait mentir leur prix. On ne corrige
 * donc pas une grille publiée, on en publie une nouvelle.
 */
const DRAFT = {
  roadFactor: 1.3,
  bands: [
    { maxKm: 3, feeXaf: 1000 },
    { maxKm: 6, feeXaf: 1500 },
  ],
  overrides: [
    { originQuartierId: 'q-poto', destQuartierId: 'q-talangai', feeXaf: 1200 },
  ],
};

describe('tariffDraftViolations', () => {
  it('une grille cohérente ne viole rien', () => {
    expect(tariffDraftViolations(DRAFT)).toEqual([]);
  });

  it('deux tranches à la même borne sont ambiguës', () => {
    const v = tariffDraftViolations({
      ...DRAFT,
      bands: [
        { maxKm: 3, feeXaf: 1000 },
        { maxKm: 3, feeXaf: 1500 },
      ],
    });
    expect(v.join(' ')).toMatch(/3 km/);
  });

  it('une paire de quartiers surchargée deux fois est ambiguë', () => {
    const v = tariffDraftViolations({
      ...DRAFT,
      overrides: [DRAFT.overrides[0], { ...DRAFT.overrides[0], feeXaf: 900 }],
    });
    expect(v.join(' ')).toMatch(/q-poto → q-talangai/);
  });
});

describe('DeliveryTariffsService', () => {
  const tx = {
    deliveryTariff: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    adminAuditLog: { create: jest.fn() },
  };
  const prisma = {
    deliveryTariff: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    deliveryTariffBand: { deleteMany: jest.fn(), createMany: jest.fn() },
    deliveryTariffOverride: { deleteMany: jest.fn(), createMany: jest.fn() },
    quartier: { count: jest.fn() },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  let service: DeliveryTariffsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.quartier.count.mockResolvedValue(2);
    prisma.deliveryTariff.aggregate.mockResolvedValue({
      _max: { version: 4 },
    });
    prisma.deliveryTariff.create.mockImplementation(
      async (args: { data: { version: number } }) => ({
        id: 't-new',
        ...args.data,
      }),
    );
    service = new DeliveryTariffsService(prisma as never);
  });

  describe('createDraft', () => {
    it('numérote à la suite de la dernière version, en brouillon', async () => {
      await service.createDraft(DRAFT, 'admin-1');
      expect(prisma.deliveryTariff.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 5,
            status: 'DRAFT',
            createdBy: 'admin-1',
          }),
        }),
      );
    });

    it('refuse une grille incohérente en 400', async () => {
      await expect(
        service.createDraft(
          { ...DRAFT, bands: [DRAFT.bands[0], DRAFT.bands[0]] },
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.deliveryTariff.create).not.toHaveBeenCalled();
    });

    it('refuse un quartier inconnu dans une surcharge', async () => {
      prisma.quartier.count.mockResolvedValue(1);
      await expect(service.createDraft(DRAFT, 'admin-1')).rejects.toThrow(
        /quartier/i,
      );
    });

    it('deux créations simultanées : la base arbitre le numéro, 409', async () => {
      prisma.deliveryTariff.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      await expect(
        service.createDraft(DRAFT, 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateDraft', () => {
    it('refuse de modifier une grille publiée (409)', async () => {
      prisma.deliveryTariff.findUnique.mockResolvedValue({
        id: 't-3',
        status: 'PUBLISHED',
      });
      await expect(service.updateDraft('t-3', DRAFT)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('grille introuvable → 404', async () => {
      prisma.deliveryTariff.findUnique.mockResolvedValue(null);
      await expect(service.updateDraft('nope', DRAFT)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('publish', () => {
    beforeEach(() => {
      tx.deliveryTariff.findUnique.mockResolvedValue({
        id: 't-5',
        version: 5,
        status: 'DRAFT',
        _count: { bands: 2 },
      });
      // Relecture de la grille publiée, hors transaction, pour la réponse.
      prisma.deliveryTariff.findUnique.mockResolvedValue({
        id: 't-5',
        status: 'PUBLISHED',
      });
      tx.deliveryTariff.updateMany
        .mockResolvedValueOnce({ count: 1 }) // ancienne → RETIRED
        .mockResolvedValueOnce({ count: 1 }); // brouillon → PUBLISHED
    });

    it('retire l’ancienne AVANT de publier la nouvelle, dans une transaction', async () => {
      await service.publish('t-5', 'admin-1');
      const [retire, publish] = tx.deliveryTariff.updateMany.mock.calls;
      expect(retire[0]).toMatchObject({
        where: { status: 'PUBLISHED' },
        data: { status: 'RETIRED' },
      });
      expect(publish[0]).toMatchObject({
        where: { id: 't-5', status: 'DRAFT' },
        data: { status: 'PUBLISHED', publishedBy: 'admin-1' },
      });
    });

    it('écrit l’audit DANS la transaction de publication', async () => {
      await service.publish('t-5', 'admin-1');
      expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorId: 'admin-1',
          action: 'DELIVERY_TARIFF_PUBLISHED',
          targetType: 'DeliveryTariff',
          targetId: 't-5',
        }),
      });
    });

    it('brouillon déjà publié par un autre admin : 409, la transaction est annulée', async () => {
      tx.deliveryTariff.updateMany.mockReset();
      tx.deliveryTariff.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });
      await expect(service.publish('t-5', 'admin-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    });

    it('refuse de publier une grille sans tranche', async () => {
      tx.deliveryTariff.findUnique.mockResolvedValue({
        id: 't-5',
        version: 5,
        status: 'DRAFT',
        _count: { bands: 0 },
      });
      await expect(service.publish('t-5', 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('deux publications simultanées : l’index unique partiel arbitre, 409', async () => {
      tx.deliveryTariff.updateMany.mockReset();
      tx.deliveryTariff.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'x',
          }),
        );
      await expect(service.publish('t-5', 'admin-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
