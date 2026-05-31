/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { Restaurant } from '@prisma/client';
import { PreorderValidatorService } from './preorder-validator.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Tests unitaires du PreorderValidator (LIL-112).
 * validatePreorderRequest = pure logique → Prisma mocké au minimum.
 * validateDailyCapacity = appelle prisma.order.count → mock.
 */
describe('PreorderValidatorService', () => {
  const baseVendor: Restaurant = {
    id: 'vendor_1',
    nom: 'Atelier de Pâtisserie',
    acceptsPreorders: true,
    preorderLeadHours: 24,
    maxOrdersPerDay: null,
  } as Restaurant;

  describe('validatePreorderRequest', () => {
    let service: PreorderValidatorService;

    beforeEach(() => {
      service = new PreorderValidatorService({} as PrismaService);
    });

    it('no-op si scheduledFor est absent (commande immédiate)', () => {
      expect(() =>
        service.validatePreorderRequest(null, baseVendor),
      ).not.toThrow();
      expect(() =>
        service.validatePreorderRequest(undefined, baseVendor),
      ).not.toThrow();
    });

    it('rejette si le vendeur n\'accepte pas les précommandes', () => {
      const tomorrow = new Date(Date.now() + 25 * 3600 * 1000);
      expect(() =>
        service.validatePreorderRequest(tomorrow, {
          ...baseVendor,
          acceptsPreorders: false,
        }),
      ).toThrow(/n'accepte pas/i);
    });

    it('rejette si scheduledFor < lead time', () => {
      // dans 1h alors que le vendeur exige 24h
      const tooSoon = new Date(Date.now() + 1 * 3600 * 1000);
      expect(() =>
        service.validatePreorderRequest(tooSoon, baseVendor),
      ).toThrow(BadRequestException);
    });

    it('accepte si scheduledFor >= lead time', () => {
      const valid = new Date(Date.now() + 25 * 3600 * 1000);
      expect(() =>
        service.validatePreorderRequest(valid, baseVendor),
      ).not.toThrow();
    });

    it('rejette au-delà de 7 jours', () => {
      const tooFar = new Date(Date.now() + 8 * 24 * 3600 * 1000);
      expect(() =>
        service.validatePreorderRequest(tooFar, baseVendor),
      ).toThrow(/7 jours/i);
    });

    it('utilise 24h comme lead par défaut si preorderLeadHours est null', () => {
      const in23h = new Date(Date.now() + 23 * 3600 * 1000);
      expect(() =>
        service.validatePreorderRequest(in23h, {
          ...baseVendor,
          preorderLeadHours: null,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('validatePreorderForCart (LIL-121, decision 1b)', () => {
    let service: PreorderValidatorService;

    beforeEach(() => {
      service = new PreorderValidatorService({} as PrismaService);
    });

    const immediateItem = { product: { madeToOrder: false, nom: 'Croissant' } };
    const preorderItem = { product: { madeToOrder: true, nom: 'Gâteau' } };

    it('panier vide : accepte sans scheduledFor', () => {
      expect(() =>
        service.validatePreorderForCart([], baseVendor, null),
      ).not.toThrow();
    });

    it('panier 100% immédiat : rejet si scheduledFor fourni', () => {
      const tomorrow = new Date(Date.now() + 25 * 3600 * 1000);
      expect(() =>
        service.validatePreorderForCart(
          [immediateItem, immediateItem],
          baseVendor,
          tomorrow,
        ),
      ).toThrow(/ne contient pas de produits sur commande/i);
    });

    it('panier 100% immédiat : OK sans scheduledFor', () => {
      expect(() =>
        service.validatePreorderForCart(
          [immediateItem, immediateItem],
          baseVendor,
          null,
        ),
      ).not.toThrow();
    });

    it('panier 100% madeToOrder : rejet si scheduledFor absent', () => {
      expect(() =>
        service.validatePreorderForCart(
          [preorderItem],
          baseVendor,
          null,
        ),
      ).toThrow(/indiquer la date/i);
    });

    it('panier 100% madeToOrder : OK avec scheduledFor valide', () => {
      const validSlot = new Date(Date.now() + 25 * 3600 * 1000);
      expect(() =>
        service.validatePreorderForCart(
          [preorderItem, preorderItem],
          baseVendor,
          validSlot,
        ),
      ).not.toThrow();
    });

    it('panier 100% madeToOrder : rejet si scheduledFor < leadHours', () => {
      const tooSoon = new Date(Date.now() + 1 * 3600 * 1000);
      expect(() =>
        service.validatePreorderForCart(
          [preorderItem],
          baseVendor,
          tooSoon,
        ),
      ).toThrow(/au moins 24h/i);
    });

    it('panier mixte : rejet defense-in-depth (2a)', () => {
      const validSlot = new Date(Date.now() + 25 * 3600 * 1000);
      expect(() =>
        service.validatePreorderForCart(
          [immediateItem, preorderItem],
          baseVendor,
          validSlot,
        ),
      ).toThrow(/mélange/i);
    });
  });

  describe('validateDailyCapacity', () => {
    it('no-op si maxOrdersPerDay est null (illimité)', async () => {
      const prismaMock = { order: { count: jest.fn() } } as unknown as PrismaService;
      const service = new PreorderValidatorService(prismaMock);

      await service.validateDailyCapacity({
        ...baseVendor,
        maxOrdersPerDay: null,
      });
      expect((prismaMock as any).order.count).not.toHaveBeenCalled();
    });

    it('accepte si commandes du jour < cap', async () => {
      const prismaMock = {
        order: { count: jest.fn().mockResolvedValue(4) },
      } as unknown as PrismaService;
      const service = new PreorderValidatorService(prismaMock);

      await expect(
        service.validateDailyCapacity({
          ...baseVendor,
          maxOrdersPerDay: 10,
        }),
      ).resolves.toBeUndefined();
    });

    it('rejette quand le cap est atteint', async () => {
      const prismaMock = {
        order: { count: jest.fn().mockResolvedValue(10) },
      } as unknown as PrismaService;
      const service = new PreorderValidatorService(prismaMock);

      await expect(
        service.validateDailyCapacity({
          ...baseVendor,
          maxOrdersPerDay: 10,
        }),
      ).rejects.toThrow(/capacité maximale/i);
    });

    it('exclut les commandes ANNULER du décompte', async () => {
      const countMock = jest.fn().mockResolvedValue(0);
      const prismaMock = {
        order: { count: countMock },
      } as unknown as PrismaService;
      const service = new PreorderValidatorService(prismaMock);

      await service.validateDailyCapacity({
        ...baseVendor,
        maxOrdersPerDay: 10,
      });

      expect(countMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { notIn: ['ANNULER'] },
          }),
        }),
      );
    });
  });
});
