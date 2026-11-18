/**
 * Lot 4 (4B-2) — double de `order.updateManyAndReturn` pour les specs qui
 * doublent `order.updateMany`.
 *
 * `OrderTransitionService.tryTransition` passe une commande à `PAYER` par
 * `updateManyAndReturn` (le même `UPDATE` rend la réservation liée). Ce double
 * délègue au `updateMany` du **même** objet (`this`), sans `select` : les
 * assertions et les simulations de concurrence écrites sur `updateMany`
 * restent valables. Chaque ligne « mise à jour » rend une commande sans
 * réservation.
 *
 * Usage : `order: { updateMany: …, updateManyAndReturn: returningUpdate() }`.
 * Après un `jest.resetAllMocks()`, reposer l'implémentation :
 * `order.updateManyAndReturn.mockImplementation(returningImpl)`.
 */
export async function returningImpl(
  this: { updateMany: (args: unknown) => Promise<{ count: number }> },
  args: Record<string, unknown>,
): Promise<{ reservationId: string | null }[]> {
  const rest = { ...args };
  delete rest.select;
  const { count } = await this.updateMany(rest);
  return Array.from({ length: count }, () => ({ reservationId: null }));
}

export const returningUpdate = () => jest.fn(returningImpl);
