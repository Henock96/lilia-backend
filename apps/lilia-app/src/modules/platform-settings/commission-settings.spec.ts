// `UpdateVendorCommerceDto` tire `@Type()` par sa chaîne d'imports : sans
// `reflect-metadata`, le fichier ne se charge même pas.
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';
import { UpdateVendorCommerceDto } from '../vendors/dto/onboarding.dto';
import { MAX_COMMISSION_PERCENT } from '../payments/money.util';

/**
 * Commission vendeur — le taux plateforme doit être réglable, et borné comme
 * son homologue par vendeur.
 *
 * ## Pourquoi ce fichier existe
 *
 * `restaurantCommissionPercent` existait en base depuis le chantier pawaPay
 * (30/08/2026) avec un `@default(10)`, et **n'était dans aucun DTO**. Le
 * `ValidationPipe` global tourne en `whitelist: true, forbidNonWhitelisted:
 * false` (`main.ts`) : un `PATCH /admin/platform-settings` portant ce champ
 * renvoyait donc **200 OK en ne changeant rien**, le champ étant silencieusement
 * retiré du corps. Panne silencieuse dans le sens le plus dangereux — celui où
 * l'administrateur croit avoir agi.
 *
 * Conséquence constatée en production le 17/09/2026 : passer la commission à 0 %
 * imposait une écriture SQL directe. Aucun chemin applicatif n'existait.
 *
 * ## Pourquoi les bornes sont comparées entre elles
 *
 * Le taux est borné à trois endroits — ce DTO, `UpdateVendorCommerceDto`, et
 * `percentToBasisPoints` qui écrête à `MAX_COMMISSION_PERCENT`. Trois littéraux
 * `50` dérivent au premier changement, et la divergence ne se voit que sur un
 * virement. On compare donc les **comportements**, pas les décorateurs : un
 * `@Max()` déplacé d'un seul côté fait échouer ce fichier.
 */
async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdatePlatformSettingsDto, payload);
  const errors = await validate(dto, { whitelist: true });
  return errors.map((e) => e.property);
}

async function vendorErrorsFor(
  payload: Record<string, unknown>,
): Promise<string[]> {
  const dto = plainToInstance(UpdateVendorCommerceDto, payload);
  const errors = await validate(dto, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('Commission vendeur — taux plateforme', () => {
  describe('UpdatePlatformSettingsDto accepte enfin le champ', () => {
    it('accepte 0 % — la cible métier au 17/09/2026', async () => {
      expect(await errorsFor({ restaurantCommissionPercent: 0 })).toEqual([]);
    });

    it('accepte un taux courant', async () => {
      expect(await errorsFor({ restaurantCommissionPercent: 10 })).toEqual([]);
    });

    it('accepte un taux décimal — 8,5 % est un taux légitime', async () => {
      expect(await errorsFor({ restaurantCommissionPercent: 8.5 })).toEqual([]);
    });

    it('refuse un taux négatif', async () => {
      expect(await errorsFor({ restaurantCommissionPercent: -1 })).toContain(
        'restaurantCommissionPercent',
      );
    });

    it('refuse un taux au-delà du plafond', async () => {
      expect(
        await errorsFor({
          restaurantCommissionPercent: MAX_COMMISSION_PERCENT + 1,
        }),
      ).toContain('restaurantCommissionPercent');
    });

    it('refuse ce qui n’est pas un nombre', async () => {
      expect(
        await errorsFor({ restaurantCommissionPercent: 'zéro' }),
      ).toContain('restaurantCommissionPercent');
    });

    it('reste omissible : ne rien envoyer ne change rien', async () => {
      expect(await errorsFor({ serviceFeePercent: 15 })).toEqual([]);
    });
  });

  describe('les deux DTO de commission bornent à l’identique', () => {
    it('acceptent tous deux exactement le plafond', async () => {
      expect(
        await errorsFor({
          restaurantCommissionPercent: MAX_COMMISSION_PERCENT,
        }),
      ).toEqual([]);
      expect(
        await vendorErrorsFor({ commissionPercent: MAX_COMMISSION_PERCENT }),
      ).toEqual([]);
    });

    it('refusent tous deux un franchissement du plafond', async () => {
      const over = MAX_COMMISSION_PERCENT + 0.01;
      expect(await errorsFor({ restaurantCommissionPercent: over })).toContain(
        'restaurantCommissionPercent',
      );
      expect(await vendorErrorsFor({ commissionPercent: over })).toContain(
        'commissionPercent',
      );
    });

    it('le plafond des DTO est celui que l’arithmétique applique', () => {
      // `percentToBasisPoints` écrête à MAX_COMMISSION_PERCENT. Un DTO plus
      // permissif ferait accepter un taux qui serait ensuite silencieusement
      // rabaissé — l'administrateur verrait un taux et le vendeur en subirait
      // un autre.
      expect(MAX_COMMISSION_PERCENT).toBe(50);
    });
  });
});
