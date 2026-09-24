import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { DeliveryFeeQueryDto } from './dto/delivery-fee-query.dto';
import { QuartiersController } from './quartiers.controller';
import { QuartiersService } from './quartiers.service';

/**
 * `GET /quartiers/delivery-fee` — devis public (discovery V1, S7/S8).
 *
 * Deux défauts sur la seule route publique de tarification :
 *  - elle ne passait pas la frontière marketplace : les frais d'un vendeur en
 *    `DRAFT` ou suspendu étaient lisibles sans authentification, alors que sa
 *    fiche, ses zones (`/restaurant-zones`) et son catalogue sont masqués ;
 *  - ses paramètres étaient des `@Query` bruts : un `restaurantId` absent
 *    arrivait jusqu'à Prisma.
 *
 * Le calcul interne (`calculateDeliveryFee`), utilisé par le checkout, reste
 * inchangé : le checkout a sa propre garde de visibilité (OrderValidator).
 */
function build(
  publicVendor: Record<string, unknown> | null,
  platformQuote: Record<string, unknown> | null = null,
) {
  const findFirst = jest.fn().mockResolvedValue(publicVendor);
  const findUnique = jest.fn().mockResolvedValue({
    id: 'r1',
    deliveryPriceMode: 'FIXED',
    fixedDeliveryFee: 1000,
    deliveryZones: [],
  });
  // `null` = mode historique VENDOR_LEGACY (F3-02).
  const pricing = {
    quoteForVendor: jest.fn().mockResolvedValue(platformQuote),
  };
  const service = new QuartiersService(
    { restaurant: { findFirst, findUnique } } as never,
    pricing as never,
  );
  return { service, findFirst, findUnique, pricing };
}

describe('Devis de livraison public — frontière et validation', () => {
  describe('DeliveryFeeQueryDto', () => {
    it('refuse une requête sans restaurantId ni quartierId', async () => {
      const errors = await validate(plainToInstance(DeliveryFeeQueryDto, {}));
      expect(errors.map((e) => e.property).sort()).toEqual([
        'quartierId',
        'restaurantId',
      ]);
    });

    it('refuse des identifiants vides', async () => {
      const errors = await validate(
        plainToInstance(DeliveryFeeQueryDto, {
          restaurantId: '',
          quartierId: '  ',
        }),
      );
      expect(errors).toHaveLength(2);
    });

    it('accepte deux identifiants renseignés', async () => {
      const errors = await validate(
        plainToInstance(DeliveryFeeQueryDto, {
          restaurantId: 'r1',
          quartierId: 'q1',
        }),
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('QuartiersService.quotePublicDeliveryFee', () => {
    it('interroge le vendeur à travers PUBLIC_VENDOR_WHERE', async () => {
      const { service, findFirst } = build({ id: 'r1' });

      await service.quotePublicDeliveryFee('r1', 'q1');

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'r1', ...PUBLIC_VENDOR_WHERE },
        }),
      );
    });

    it('répond 404 pour un vendeur non publié, sans rien calculer', async () => {
      const { service, findUnique } = build(null);

      await expect(
        service.quotePublicDeliveryFee('draft', 'q1'),
      ).rejects.toThrow(NotFoundException);
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('délègue au calcul existant pour un vendeur publié', async () => {
      const { service } = build({ id: 'r1' });

      await expect(service.quotePublicDeliveryFee('r1', 'q1')).resolves.toEqual(
        expect.objectContaining({ mode: 'FIXED', fee: 1000 }),
      );
    });
  });

  /**
   * F3-02 — en mode PLATFORM, le devis public passe par le MÊME moteur que le
   * checkout : le prix affiché est le prix facturé. La clé `fee` reste le
   * prix client, pour les apps déjà publiées qui ne lisent qu'elle.
   */
  describe('mode PLATFORM (F3-02)', () => {
    const VENDOR = {
      id: 'r1',
      latitude: -4.2634,
      longitude: 15.2729,
      quartierId: 'q-poto',
      deliverySubsidyMode: 'FREE_ABOVE',
      deliverySubsidyXaf: null,
      freeDeliveryThresholdXaf: 10000,
    };
    const QUOTE = {
      tariffVersion: 2,
      baseFeeXaf: 1500,
      subsidyXaf: 0,
      customerFeeXaf: 1500,
      distanceKm: 4.1,
      basis: 'BAND',
    };

    it('répond avec le prix client dans `fee`, et le détail du devis', async () => {
      const { service } = build(VENDOR, QUOTE);
      await expect(
        service.quotePublicDeliveryFee('r1', 'q-moungali', 7700),
      ).resolves.toEqual({
        mode: 'PLATFORM',
        fee: 1500,
        baseFee: 1500,
        vendorSubsidy: 0,
        distanceKm: 4.1,
        tariffVersion: 2,
        freeDeliveryThreshold: 10000,
      });
    });

    it('passe le vendeur, le quartier et le sous-total au moteur', async () => {
      const { service, pricing } = build(VENDOR, QUOTE);
      await service.quotePublicDeliveryFee('r1', 'q-moungali', 7700);
      expect(pricing.quoteForVendor).toHaveBeenCalledWith({
        vendor: VENDOR,
        destination: {
          quartierId: 'q-moungali',
          latitude: null,
          longitude: null,
        },
        subTotalXaf: 7700,
      });
    });

    it('sans sous-total : devis au prix plein (pas de livraison offerte présumée)', async () => {
      const { service, pricing } = build(VENDOR, QUOTE);
      await service.quotePublicDeliveryFee('r1', 'q-moungali');
      expect(pricing.quoteForVendor).toHaveBeenCalledWith(
        expect.objectContaining({ subTotalXaf: 0 }),
      );
    });

    it('seuil annoncé seulement en mode « offerte dès X »', async () => {
      const { service } = build(
        { ...VENDOR, deliverySubsidyMode: 'FIXED', deliverySubsidyXaf: 300 },
        { ...QUOTE, subsidyXaf: 300, customerFeeXaf: 1200 },
      );
      const res = await service.quotePublicDeliveryFee('r1', 'q-moungali');
      expect(res).toMatchObject({ fee: 1200, vendorSubsidy: 300 });
      expect(res).toMatchObject({ freeDeliveryThreshold: null });
    });

    it('ne lit pas le prix du vendeur', async () => {
      const { service, findUnique } = build(VENDOR, QUOTE);
      await service.quotePublicDeliveryFee('r1', 'q-moungali');
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('DeliveryFeeQueryDto — subTotal (F3-02)', () => {
    it('accepte un sous-total entier positif, venu en chaîne', async () => {
      const dto = plainToInstance(DeliveryFeeQueryDto, {
        restaurantId: 'r1',
        quartierId: 'q1',
        subTotal: '7700',
      });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.subTotal).toBe(7700);
    });

    it('refuse un sous-total négatif ou décimal', async () => {
      for (const subTotal of ['-1', '12.5', 'abc']) {
        const errors = await validate(
          plainToInstance(DeliveryFeeQueryDto, {
            restaurantId: 'r1',
            quartierId: 'q1',
            subTotal,
          }),
        );
        expect(errors.map((e) => e.property)).toEqual(['subTotal']);
      }
    });
  });

  it('le contrôleur passe par le devis public, jamais par le calcul interne', async () => {
    const quartiersService = {
      quotePublicDeliveryFee: jest.fn().mockResolvedValue({ fee: 1000 }),
      calculateDeliveryFee: jest.fn(),
    };
    const controller = new QuartiersController(
      quartiersService as never,
      {} as never,
    );

    await controller.calculateDeliveryFee({
      restaurantId: 'r1',
      quartierId: 'q1',
    });

    expect(quartiersService.quotePublicDeliveryFee).toHaveBeenCalledWith(
      'r1',
      'q1',
      undefined,
    );
    expect(quartiersService.calculateDeliveryFee).not.toHaveBeenCalled();
  });
});
