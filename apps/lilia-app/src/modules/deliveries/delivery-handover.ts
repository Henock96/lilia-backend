import { randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Preuve de remise d'une course (Master Audit v1, F-06).
 *
 * Avant : `PATCH /deliveries/:id/status { LIVRER }` suffisait. Un livreur qui
 * gardait la commande, ou la déposait ailleurs, la déclarait livrée d'un tap —
 * fidélité et parrainage crédités, course comptée dans sa paie, client sans
 * recours.
 *
 * Maintenant : au retrait du repas, un code à 4 chiffres est tiré et montré au
 * CLIENT seul. Le livreur ne peut conclure qu'en saisissant ce que le client
 * lui donne à la porte.
 *
 * Pourquoi un code et pas une photo ou le GPS : c'est la seule preuve qui
 * suppose la présence du client. Une photo se prend n'importe où ; le GPS se
 * falsifie et, à Brazzaville, la destination n'est souvent qu'approximative
 * (`LocationPrecision.APPROXIMATE`). Le code ne demande ni caméra ni réseau
 * fiable, et se dicte au téléphone si le client est absent de chez lui.
 */

/** Longueur du code. 4 chiffres : se dicte, se tape sur un clavier numérique. */
export const HANDOVER_CODE_LENGTH = 4;

/**
 * Saisies autorisées, la bonne comprise. Chaque saisie consomme un essai
 * AVANT la comparaison : une rafale de 100 requêtes parallèles ne teste donc
 * pas plus de codes qu'une saisie à la main (5 sur 10 000).
 */
export const HANDOVER_MAX_ATTEMPTS = 5;

/** Tirage uniforme sur 0000–9999, par le générateur cryptographique. */
export function generateHandoverCode(): string {
  return randomInt(0, 10 ** HANDOVER_CODE_LENGTH)
    .toString()
    .padStart(HANDOVER_CODE_LENGTH, '0');
}

/** Comparaison en temps constant — le code ne se devine pas au chronomètre. */
export function handoverCodeMatches(
  expected: string,
  provided: string,
): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}
