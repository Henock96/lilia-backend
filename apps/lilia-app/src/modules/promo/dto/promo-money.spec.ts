import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';

import { CreatePromoCodeDto, DiscountType } from './create-promo-code.dto';

/**
 * Intégrité monétaire des codes promo (dette M12).
 *
 * `discountValue` est le seul champ resté `Float` en base, parce qu'il porte un
 * montant XAF quand `discountType === FIXED` et un **pourcentage** quand il
 * vaut `PERCENT`. Toute la règle se joue donc dans le DTO, où le discriminant
 * est connu.
 *
 * ⚠️ La première rédaction empilait deux `@ValidateIf` sur la propriété.
 * class-validator combine ces conditions en **ET** : `type === FIXED &&
 * type === PERCENT` est toujours faux, donc la propriété n'était **jamais**
 * validée — un validateur qui laisse tout passer en ayant l'air strict. Le test
 * « rejette 500,5 en FIXED » est celui qui l'attrape.
 */
function errorsAt(dto: object, path: string): string[] {
  const walk = (errors: ValidationError[], prefix: string): string[] =>
    errors.flatMap((e) => {
      const here = prefix ? `${prefix}.${e.property}` : e.property;
      return [
        ...(here === path ? Object.values(e.constraints ?? {}) : []),
        ...walk(e.children ?? [], here),
      ];
    });
  return walk(validateSync(dto, { whitelist: true }), '');
}

const base = { code: 'BIENVENUE', startsAt: new Date().toISOString() };

describe('CreatePromoCodeDto — montants XAF', () => {
  describe('discountValue en FIXED (un montant)', () => {
    it('rejette une remise à virgule', () => {
      const dto = plainToInstance(CreatePromoCodeDto, {
        ...base,
        discountType: DiscountType.FIXED,
        discountValue: 500.5,
      });
      const messages = errorsAt(dto, 'discountValue');
      expect(messages).not.toHaveLength(0);
      expect(messages.join(' ')).toContain('francs CFA');
    });

    it('accepte une remise entière', () => {
      const dto = plainToInstance(CreatePromoCodeDto, {
        ...base,
        discountType: DiscountType.FIXED,
        discountValue: 500,
      });
      expect(errorsAt(dto, 'discountValue')).toHaveLength(0);
    });
  });

  describe('discountValue en PERCENT (une proportion)', () => {
    it('accepte 7,5 % — capacité commerciale réelle', () => {
      // C'est la raison pour laquelle la colonne reste `Float` : la passer en
      // `Int` interdirait cette campagne sans que personne ne l'ait décidé.
      const dto = plainToInstance(CreatePromoCodeDto, {
        ...base,
        discountType: DiscountType.PERCENT,
        discountValue: 7.5,
      });
      expect(errorsAt(dto, 'discountValue')).toHaveLength(0);
    });

    it('rejette un pourcentage au-dessus de 100', () => {
      const dto = plainToInstance(CreatePromoCodeDto, {
        ...base,
        discountType: DiscountType.PERCENT,
        discountValue: 150,
      });
      expect(errorsAt(dto, 'discountValue').join(' ')).toMatch(/0 et 100/);
    });
  });

  it('rejette une valeur négative, quel que soit le type', () => {
    for (const discountType of [DiscountType.FIXED, DiscountType.PERCENT]) {
      const dto = plainToInstance(CreatePromoCodeDto, {
        ...base,
        discountType,
        discountValue: -1,
      });
      expect(errorsAt(dto, 'discountValue')).not.toHaveLength(0);
    }
  });

  describe('maxDiscount et minOrderAmount — toujours des montants', () => {
    it('rejettent une valeur à virgule', () => {
      const dto = plainToInstance(CreatePromoCodeDto, {
        ...base,
        discountType: DiscountType.PERCENT,
        discountValue: 10,
        maxDiscount: 2000.5,
        minOrderAmount: 1500.25,
      });
      expect(errorsAt(dto, 'maxDiscount').join(' ')).toContain('francs CFA');
      expect(errorsAt(dto, 'minOrderAmount').join(' ')).toContain('francs CFA');
    });

    it('acceptent des entiers', () => {
      const dto = plainToInstance(CreatePromoCodeDto, {
        ...base,
        discountType: DiscountType.PERCENT,
        discountValue: 10,
        maxDiscount: 2000,
        minOrderAmount: 1500,
      });
      expect(errorsAt(dto, 'maxDiscount')).toHaveLength(0);
      expect(errorsAt(dto, 'minOrderAmount')).toHaveLength(0);
    });
  });
});
