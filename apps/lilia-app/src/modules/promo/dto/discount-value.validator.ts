import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import { DiscountType } from './create-promo-code.dto';

/**
 * `discountValue` est monétaire **une fois sur deux**.
 *
 * `FIXED` → un montant en francs CFA, donc entier.
 * `PERCENT` → une proportion, où 7,5 % est légitime, bornée à 100.
 * `FREE_DELIVERY` → la valeur n'est pas lue.
 *
 * ⚠️ Empiler deux `@ValidateIf` sur la même propriété **ne marche pas** :
 * class-validator combine les conditions en ET, et
 * `type === FIXED && type === PERCENT` est toujours faux — la propriété ne
 * serait alors jamais validée du tout. D'où cette contrainte unique, qui lit
 * le discriminant frère et décide elle-même.
 */
@ValidatorConstraint({ name: 'promoDiscountValue', async: false })
export class PromoDiscountValueConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return false;
    }
    const type = (args.object as { discountType?: DiscountType }).discountType;

    if (type === DiscountType.FIXED) return Number.isInteger(value);
    if (type === DiscountType.PERCENT) return value <= 100;
    return true; // FREE_DELIVERY : la valeur n'est pas utilisée
  }

  defaultMessage(args: ValidationArguments): string {
    const type = (args.object as { discountType?: DiscountType }).discountType;
    if (type === DiscountType.FIXED) {
      return 'Une remise en montant fixe est un nombre entier de francs CFA — le XAF n’a pas de sous-unité.';
    }
    if (type === DiscountType.PERCENT) {
      return 'Un pourcentage de remise doit être compris entre 0 et 100.';
    }
    return 'Valeur de remise invalide.';
  }
}
