import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import {
  pickupClientMessage,
  pickupVendorMessage,
} from '../listeners/orders.listener';
import { PickupHandoverDto } from './dto/pickup-handover.dto';
import { staffDeliveryProof } from './order-lifecycle.service';
import {
  AUTO_PAYOUT_PROOFS,
  DELIVERY_PROOFS,
  payoutDueAtFor,
} from './order-transition.types';
import { OrdersController } from './orders.controller';

/**
 * F3-07 — preuve de remise d'un retrait au comptoir : ce qui se vérifie sans
 * base. Le parcours complet, les CHECK et les courses concurrentes sont dans
 * `test/integration/pickup-proof.int-spec.ts`.
 */
describe('Preuve de remise (F3-07)', () => {
  describe('routes : qui peut prouver quoi', () => {
    const proto = OrdersController.prototype as unknown as Record<
      string,
      object
    >;

    it.each([
      ['confirmPickup', ':id/pickup/confirm', ['CLIENT']],
      ['handOverPickup', ':id/pickup/handover', ['RESTAURATEUR']],
    ])('%s : POST %s, réservé à %j', (name, path, roles) => {
      const handler = proto[name];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.POST,
      );
      // I-12 — l'ADMIN n'est PAS dans la liste : il ne confirme jamais à la
      // place du client, et sa clôture passe par la route de statut.
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(roles);
    });
  });

  describe('code saisi par le vendeur', () => {
    it.each(['4821', '0007'])('« %s » est accepté', async (code) => {
      const errors = await validate(
        plainToInstance(PickupHandoverDto, { code }),
      );
      expect(errors).toHaveLength(0);
    });

    it.each(['482', '48210', 'abcd', '', ' 4821'])(
      '« %s » est refusé avant d’atteindre le service',
      async (code) => {
        const errors = await validate(
          plainToInstance(PickupHandoverDto, { code }),
        );
        expect(errors).not.toHaveLength(0);
      },
    );
  });

  describe('les listes TypeScript et les CHECK SQL disent la même chose', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../../prisma/migrations/20260925120000_order_delivery_proof/migration.sql',
      ),
      'utf8',
    );
    const valuesOf = (constraint: string) => {
      const start = sql.indexOf(`"${constraint}"`);
      const block = sql.slice(start, sql.indexOf(');', start));
      return [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    };

    it('I-1 — DELIVERY_PROOFS = Order_deliveryProof_valid', () => {
      expect(valuesOf('Order_deliveryProof_valid').sort()).toEqual(
        [...DELIVERY_PROOFS].sort(),
      );
    });

    it('I-6/I-7 — AUTO_PAYOUT_PROOFS = Order_payoutDueAt_needs_proof', () => {
      expect(valuesOf('Order_payoutDueAt_needs_proof').sort()).toEqual(
        [...AUTO_PAYOUT_PROOFS].sort(),
      );
    });

    it('la remise déclarée par le vendeur seul et la course sans code ne paient jamais seules', () => {
      expect(AUTO_PAYOUT_PROOFS).not.toContain('PICKUP_VENDOR_DECLARED');
      expect(AUTO_PAYOUT_PROOFS).not.toContain('DELIVERY_UNVERIFIED');
    });
  });

  describe('payoutDueAtFor', () => {
    const at = new Date('2026-09-25T10:00:00Z');

    it('preuve fiable : preuve + délai', () => {
      expect(payoutDueAtFor('PICKUP_CUSTOMER_CONFIRMED', at, 60)).toEqual(
        new Date('2026-09-25T11:00:00Z'),
      );
      expect(payoutDueAtFor('PICKUP_CODE', at, 0)).toEqual(at);
    });

    it.each(['PICKUP_VENDOR_DECLARED', 'DELIVERY_UNVERIFIED'] as const)(
      '%s : aucune échéance, quel que soit le délai',
      (proof) => {
        expect(payoutDueAtFor(proof, at, 60)).toBeNull();
      },
    );
  });

  describe('clôture par la route de statut', () => {
    it('le vendeur qui remet seul ne prouve rien (D-P1)', () => {
      expect(staffDeliveryProof(false, 'RESTAURATEUR')).toBe(
        'PICKUP_VENDOR_DECLARED',
      );
    });

    it('l’admin arbitre (D-P3), sur un retrait comme sur une course', () => {
      expect(staffDeliveryProof(false, 'ADMIN')).toBe('PICKUP_ADMIN_OVERRIDE');
      expect(staffDeliveryProof(true, 'ADMIN')).toBe('DELIVERY_ADMIN_OVERRIDE');
    });
  });

  describe('messages d’un retrait', () => {
    it('prête : on parle du comptoir et du code, sans le montrer dans la notification', () => {
      const msg = pickupClientMessage('PRET', null);
      expect(msg.body).toMatch(/comptoir/);
      expect(msg.body).not.toMatch(/\d{4}/);
    });

    it('remise déclarée par le vendeur : on demande au client de confirmer', () => {
      expect(
        pickupClientMessage('LIVRER', 'PICKUP_VENDOR_DECLARED').body,
      ).toMatch(/confirmez/i);
      expect(
        pickupVendorMessage('ABC123', 'PICKUP_VENDOR_DECLARED').body,
      ).toMatch(/partira dès que le client aura confirmé/);
    });

    it('remise prouvée : jamais « livrée » pour un retrait', () => {
      for (const proof of ['PICKUP_CODE', 'PICKUP_CUSTOMER_CONFIRMED']) {
        expect(pickupClientMessage('LIVRER', proof).title).not.toMatch(
          /livrée/i,
        );
        expect(pickupVendorMessage('ABC123', proof).body).toMatch(
          /paiement peut partir/,
        );
      }
    });
  });
});
