import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';

import { ModifierSelectionError } from './modifier-selection';

/**
 * Traduction HTTP des refus du moteur d'options.
 *
 * Le corps porte toujours `{ message, code }` (même forme que les refus de
 * remboursement ou de transition) : `message` est affichable tel quel,
 * `code` est le contrat que les clients traduisent ou testent.
 *
 * - **ajout au panier** : 409 si l'option est en rupture/supprimée (l'état du
 *   catalogue a changé), 400 sinon (la requête est mal formée ou incomplète —
 *   dont `MODIFIER_REQUIRED` pour une application ancienne) ;
 * - **checkout** : toujours 409 — la requête était juste, c'est le panier qui
 *   ne l'est plus. `cartItemId` désigne la ligne à corriger.
 */
export function modifierErrorForCart(
  err: ModifierSelectionError,
): HttpException {
  const body = { message: err.message, code: err.code };
  return err.code === 'MODIFIER_UNAVAILABLE'
    ? new ConflictException(body)
    : new BadRequestException(body);
}

export function modifierErrorForCheckout(
  err: ModifierSelectionError,
  cartItemId: string,
): HttpException {
  return new ConflictException({
    message: err.message,
    code: err.code,
    cartItemId,
  });
}
