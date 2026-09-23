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
    function build(publicVendor: { id: string } | null) {
      const findFirst = jest.fn().mockResolvedValue(publicVendor);
      const findUnique = jest.fn().mockResolvedValue({
        id: 'r1',
        deliveryPriceMode: 'FIXED',
        fixedDeliveryFee: 1000,
        deliveryZones: [],
      });
      const service = new QuartiersService({
        restaurant: { findFirst, findUnique },
      } as never);
      return { service, findFirst, findUnique };
    }

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
    );
    expect(quartiersService.calculateDeliveryFee).not.toHaveBeenCalled();
  });
});
