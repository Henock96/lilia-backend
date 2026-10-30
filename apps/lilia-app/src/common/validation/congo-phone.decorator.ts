import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

/**
 * Séparateurs qu'un client tape ou qu'un clavier mobile insère dans un
 * numéro : espaces, points, tirets, parenthèses.
 */
const PHONE_SEPARATORS = /[\s.\-()]/g;

/**
 * Mobile congolais : `04`, `05` ou `06` puis sept chiffres, indicatif `+242`
 * ou `242` facultatif. Le zéro national est facultatif pour rester compatible
 * avec les anciennes versions de l'app, qui l'ôtaient (`toMsisdn` le remet).
 */
const CONGO_MOBILE = /^(\+?242)?0?[456]\d{7}$/;

/**
 * Même règle, hors DTO : le numéro sans séparateurs s'il est un mobile
 * congolais, sinon `null`. Sert quand le numéro vient du compte (`User.phone`)
 * et non du corps de la requête (Lot 4, réservations).
 */
export function cleanCongoMobilePhone(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(PHONE_SEPARATORS, '');
  return CONGO_MOBILE.test(cleaned) ? cleaned : null;
}

export const CONGO_PHONE_MESSAGE =
  'Numéro de téléphone congolais invalide (ex : 06 123 45 67)';

/**
 * Numéro de mobile congolais, **normalisé avant d'être validé**.
 *
 * Une seule règle pour tous les champs saisis par un client. `CreateOrderDto`
 * retirait les séparateurs, `CreatePaymentDto` non : le même numéro créait la
 * commande puis faisait échouer l'encaissement en 400. La valeur qui atteint
 * le handler est celle sans séparateurs, et c'est elle qui est persistée.
 *
 * Nécessite la `ValidationPipe` globale avec `transform: true` (`main.ts`).
 */
export function IsCongoMobilePhone(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.replace(PHONE_SEPARATORS, '') : value,
    ),
    IsString(),
    Matches(CONGO_MOBILE, { message: CONGO_PHONE_MESSAGE }),
  );
}
