import { BadRequestException } from '@nestjs/common';
import { OrderValidatorService } from './order-validator.service';

/**
 * Mode de service (Lot 1) — `supportsDelivery` / `supportsPickup` sont la
 * seule autorité sur ce que le client peut choisir.
 *
 * Chaque ligne est écrite à la main : dériver les attentes des deux booléens
 * reproduirait la règle au lieu de la vérifier (cf. la spec « exhaustive » de
 * la machine d'états, qui ne protégeait rien pour cette raison).
 */
describe('OrderValidatorService.validateServiceMode', () => {
  const validator = new OrderValidatorService(
    {} as never,
    {} as never,
    {} as never,
  );

  const vendor = (supportsDelivery: boolean, supportsPickup: boolean) => ({
    nom: 'Chez Mama',
    supportsDelivery,
    supportsPickup,
  });

  function refusal(fn: () => void) {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return (e as BadRequestException).getResponse() as {
        message: string;
        code: string;
      };
    }
    throw new Error('aucun refus levé');
  }

  describe('livraison seulement', () => {
    const v = vendor(true, false);

    it('livraison demandée → acceptée', () => {
      expect(() => validator.validateServiceMode(v, true)).not.toThrow();
    });

    it('retrait demandé → refusé, PICKUP_UNAVAILABLE, invite à la livraison', () => {
      const body = refusal(() => validator.validateServiceMode(v, false));
      expect(body.code).toBe('PICKUP_UNAVAILABLE');
      expect(body.message).toBe(
        '« Chez Mama » ne propose pas le retrait sur place. Choisissez la livraison.',
      );
    });
  });

  describe('retrait seulement', () => {
    const v = vendor(false, true);

    it('retrait demandé → accepté', () => {
      expect(() => validator.validateServiceMode(v, false)).not.toThrow();
    });

    it('livraison demandée → refusée, DELIVERY_UNAVAILABLE, invite au retrait', () => {
      const body = refusal(() => validator.validateServiceMode(v, true));
      expect(body.code).toBe('DELIVERY_UNAVAILABLE');
      expect(body.message).toBe(
        '« Chez Mama » ne propose pas la livraison. Choisissez le retrait sur place.',
      );
    });
  });

  describe('livraison et retrait (comportement historique)', () => {
    const v = vendor(true, true);

    it('livraison demandée → acceptée', () => {
      expect(() => validator.validateServiceMode(v, true)).not.toThrow();
    });

    it('retrait demandé → accepté', () => {
      expect(() => validator.validateServiceMode(v, false)).not.toThrow();
    });
  });

  describe('aucun mode (état refusé à l’écriture, mais lisible en base)', () => {
    const v = vendor(false, false);

    it('livraison demandée → refusée, sans proposer un retrait inexistant', () => {
      const body = refusal(() => validator.validateServiceMode(v, true));
      expect(body.code).toBe('DELIVERY_UNAVAILABLE');
      expect(body.message).toBe('« Chez Mama » ne propose pas la livraison.');
    });

    it('retrait demandé → refusé, sans proposer une livraison inexistante', () => {
      const body = refusal(() => validator.validateServiceMode(v, false));
      expect(body.code).toBe('PICKUP_UNAVAILABLE');
      expect(body.message).toBe(
        '« Chez Mama » ne propose pas le retrait sur place.',
      );
    });
  });

  it('ne divulgue que le nom public du vendeur', () => {
    const body = refusal(() =>
      validator.validateServiceMode(
        { ...vendor(false, true), payoutPhoneNumber: '242061234567' } as never,
        true,
      ),
    );
    expect(JSON.stringify(body)).not.toContain('242061234567');
  });
});
