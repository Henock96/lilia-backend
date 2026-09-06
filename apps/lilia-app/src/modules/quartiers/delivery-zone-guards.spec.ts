import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DeliveryPriceMode } from '@prisma/client';

import { DeliveryZonesService } from './delivery-zones.service';
import { RestaurantsService } from '../restaurants/restaurants.service';

const { FIXED, ZONE_BASED } = DeliveryPriceMode;

/**
 * L'invariant de couverture doit tenir **sur les chemins d'écriture**, pas
 * seulement dans la checklist d'activation (fix L-3).
 *
 * Le prédicat lui-même est couvert par `common/delivery/zone-coverage.spec.ts`.
 * Ici on vérifie l'autre moitié : que chacun des chemins qui peuvent violer
 * l'invariant l'appelle réellement. C'est exactement la distinction qui manquait
 * — la règle *existait*, écrite une fois, et deux services sur trois ne la
 * consultaient pas.
 *
 * Constaté en production avant correction : « Le Cosy Lounge Brazza » en
 * `ZONE_BASED` avec zéro zone, toutes ses livraisons facturées au tarif de
 * repli sans qu'aucun écran ne le signale.
 */
describe('Zones de livraison — les garde-fous d’écriture', () => {
  describe('RestaurantsService.updateDeliverySettings', () => {
    function build(restaurant: Record<string, unknown>, zoneCount: number) {
      const update = jest.fn().mockResolvedValue({ id: 'r1' });
      const prisma = {
        restaurant: { update },
        deliveryZone: { count: jest.fn().mockResolvedValue(zoneCount) },
      };
      const access = {
        verifyOwnership: jest.fn().mockResolvedValue({
          id: 'r1',
          nom: 'Chez Awa',
          deliveryPriceMode: FIXED,
          supportsDelivery: true,
          estimatedDeliveryTimeMin: 15,
          estimatedDeliveryTimeMax: 30,
          ...restaurant,
        }),
      };
      const service = new RestaurantsService(
        prisma as never,
        access as never,
        {} as never,
        {} as never,
      );
      return { service, update };
    }

    it('refuse la bascule en ZONE_BASED quand le vendeur n’a aucune zone', async () => {
      const { service, update } = build({}, 0);

      await expect(
        service.updateDeliverySettings('r1', 'fb', {
          deliveryPriceMode: ZONE_BASED,
        }),
      ).rejects.toThrow(BadRequestException);

      // Le refus doit précéder l'écriture : accepter puis corriger laisserait
      // une fenêtre pendant laquelle le catalogue facture au repli.
      expect(update).not.toHaveBeenCalled();
    });

    it('accepte la bascule quand au moins une zone existe', async () => {
      const { service, update } = build({}, 2);

      await service.updateDeliverySettings('r1', 'fb', {
        deliveryPriceMode: ZONE_BASED,
      });

      expect(update).toHaveBeenCalled();
    });

    it('refuse aussi un vendeur DÉJÀ en ZONE_BASED qui modifie autre chose', async () => {
      // Cas réel : le vendeur est déjà dans l'état incohérent (hérité d'avant
      // ce correctif). Le laisser enregistrer un autre champ entérinerait la
      // configuration cassée sans jamais la signaler.
      const { service } = build({ deliveryPriceMode: ZONE_BASED }, 0);

      await expect(
        service.updateDeliverySettings('r1', 'fb', { fixedDeliveryFee: 1500 }),
      ).rejects.toThrow(/zone de livraison/i);
    });

    it('laisse un vendeur incohérent revenir en tarif fixe', async () => {
      // La porte de sortie doit rester ouverte, sinon les vendeurs déjà dans
      // cet état sont bloqués par le correctif lui-même.
      const { service, update } = build({ deliveryPriceMode: ZONE_BASED }, 0);

      await service.updateDeliverySettings('r1', 'fb', {
        deliveryPriceMode: FIXED,
      });

      expect(update).toHaveBeenCalled();
    });

    it('refuse un délai minimum supérieur au délai maximum', async () => {
      const { service } = build({}, 0);

      await expect(
        service.updateDeliverySettings('r1', 'fb', {
          estimatedDeliveryTimeMin: 45,
          estimatedDeliveryTimeMax: 20,
        }),
      ).rejects.toThrow(/délai minimum/i);
    });
  });

  describe('DeliveryZonesService.deleteDeliveryZone', () => {
    function build(
      restaurant: Record<string, unknown>,
      remainingAfterDeletion: number,
    ) {
      const del = jest.fn().mockResolvedValue({});
      const prisma = {
        deliveryZone: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'z1',
            restaurantId: 'r1',
            restaurant: {
              id: 'r1',
              ownerId: 'u1',
              deliveryPriceMode: ZONE_BASED,
              supportsDelivery: true,
              ...restaurant,
            },
          }),
          count: jest.fn().mockResolvedValue(remainingAfterDeletion),
          delete: del,
        },
        restaurant: {
          findUnique: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'u1' }),
        },
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'u1', role: 'RESTAURATEUR' }),
        },
        quartierZone: { deleteMany: jest.fn() },
      };
      return {
        service: new DeliveryZonesService(prisma as never),
        del,
        prisma,
      };
    }

    it('refuse de supprimer la dernière zone d’un vendeur ZONE_BASED', async () => {
      const { service, del } = build({}, 0);

      await expect(service.deleteDeliveryZone('z1', 'fb')).rejects.toThrow(
        BadRequestException,
      );
      expect(del).not.toHaveBeenCalled();
    });

    it('autorise la suppression tant qu’il reste une zone', async () => {
      const { service, del } = build({}, 1);

      await service.deleteDeliveryZone('z1', 'fb');

      expect(del).toHaveBeenCalledWith({ where: { id: 'z1' } });
    });

    it('autorise la suppression de la dernière zone d’un vendeur en tarif fixe', async () => {
      const { service, del } = build({ deliveryPriceMode: FIXED }, 0);

      await service.deleteDeliveryZone('z1', 'fb');

      expect(del).toHaveBeenCalled();
    });

    it('s’en remet à la cascade PostgreSQL pour les rattachements', async () => {
      // `QuartierZone.deliveryZoneId` est en `onDelete: Cascade` depuis
      // l'activation des clés étrangères. Le `deleteMany` manuel qui précédait
      // était l'émulation de l'époque `relationMode = "prisma"` — il faisait
      // de cette suppression deux écritures non atomiques.
      const { service, prisma } = build({}, 1);

      await service.deleteDeliveryZone('z1', 'fb');

      expect(prisma.quartierZone.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('DeliveryZonesService.getManagedDeliveryZones', () => {
    function build(zones: unknown[], quartiers: unknown[], role = 'ADMIN') {
      const prisma = {
        deliveryZone: { findMany: jest.fn().mockResolvedValue(zones) },
        quartier: { findMany: jest.fn().mockResolvedValue(quartiers) },
        restaurant: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            nom: 'Chez Maman Lili',
            ownerId: 'someone-else',
            deliveryPriceMode: ZONE_BASED,
            fixedDeliveryFee: 1000,
            minimumOrderAmount: 0,
            estimatedDeliveryTimeMin: 15,
            estimatedDeliveryTimeMax: 30,
            supportsDelivery: true,
            supportsPickup: true,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ id: 'u-admin', role }),
        },
      };
      return new DeliveryZonesService(prisma as never);
    }

    const QUARTIERS = [
      { id: 'q1', nom: 'Poto-Poto' },
      { id: 'q2', nom: 'Bacongo' },
      { id: 'q3', nom: 'Makélékélé' },
    ];

    it('calcule les quartiers orphelins côté serveur', async () => {
      // La couverture est une règle métier : c'est elle qui dit quels clients
      // paieront le tarif de repli. La laisser à l'interface, c'est en avoir
      // une version par client.
      const service = build(
        [{ id: 'z1', fee: 500, quartiers: [{ quartierId: 'q1' }] }],
        QUARTIERS,
      );

      const { data } = await service.getManagedDeliveryZones('r1', 'fb-admin');

      expect(data.coverage).toMatchObject({
        totalQuartiers: 3,
        coveredQuartiers: 1,
        fallbackFee: 1000,
      });
      expect(data.coverage.uncovered.map((q) => q.nom)).toEqual([
        'Bacongo',
        'Makélékélé',
      ]);
    });

    it('rend une couverture vide quand aucune zone n’existe', async () => {
      const service = build([], QUARTIERS);

      const { data } = await service.getManagedDeliveryZones('r1', 'fb-admin');

      expect(data.coverage.coveredQuartiers).toBe(0);
      expect(data.coverage.uncovered).toHaveLength(3);
    });

    it('refuse un RESTAURATEUR qui n’est pas le propriétaire', async () => {
      const service = build([], QUARTIERS, 'RESTAURATEUR');

      await expect(
        service.getManagedDeliveryZones('r1', 'fb-autre'),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
