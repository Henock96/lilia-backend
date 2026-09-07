/**
 * Normalisation d'un numéro de téléphone congolais pour **comparaison**.
 *
 * Elle existe pour un seul usage : décider si deux comptes portent le même
 * numéro (signal `PHONE_REUSED` du scoring de parrainage). Sans elle,
 * `06 123 45 67`, `+242 06 1234567` et `242061234567` seraient trois personnes
 * différentes — et un fraudeur n'a aucune raison de saisir deux fois la même
 * forme.
 *
 * ⚠️ **Ce n'est pas un formateur d'affichage ni un formateur d'appel.** Le
 * format attendu par les opérateurs (MSISDN pawaPay / MTN) est produit par
 * `payments/mtn-momo-phone.util.ts`, qui a ses propres règles — notamment la
 * réinsertion du zéro initial. Les deux ne doivent pas être confondus : celui-ci
 * *supprime* le zéro national pour rendre les formes comparables, l'autre le
 * remet pour que l'appel aboutisse.
 *
 * La forme canonique produite ici est **sans indicatif ni zéro** :
 * `+242 06 123 45 67` → `61234567`.
 */

/** Indicatif du Congo-Brazzaville. */
const COUNTRY_CODE = '242';

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Ne garder que les chiffres : espaces, tirets, points, parenthèses et le
  // `+` sont de la mise en forme, jamais de l'information.
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;

  // Indicatif pays, avec ou sans les `00` internationaux.
  if (digits.startsWith(`00${COUNTRY_CODE}`)) {
    digits = digits.slice(2 + COUNTRY_CODE.length);
  } else if (digits.startsWith(COUNTRY_CODE) && digits.length > 9) {
    digits = digits.slice(COUNTRY_CODE.length);
  }

  // Zéro national. On ne le retire que s'il reste un numéro derrière : « 0 »
  // seul n'est pas un numéro, et le réduire à la chaîne vide ferait collisionner
  // tous les comptes qui l'auraient saisi.
  if (digits.startsWith('0') && digits.length > 1) {
    digits = digits.slice(1);
  }

  // Trop court pour être un numéro : on préfère rendre `null` (« signal
  // indisponible ») plutôt qu'une valeur qui ferait de faux rapprochements.
  if (digits.length < 6) return null;

  return digits;
}
