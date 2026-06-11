/* eslint-disable prettier/prettier */

/**
 * Helpers téléphone MTN MoMo — fonctions pures testables (extrait de
 * MtnMomoService — LIL-146). Aucune dépendance ni état.
 */

export function validateMtnPhoneNumber(phoneNumber: string, countryCode: string = '242'): boolean {
  const cleaned = phoneNumber.replace(/\s+/g, '');

  // Patterns pour différents pays (ajoutez selon vos besoins)
  const patterns: Record<string, RegExp> = {
    '237': /^(237)?[67][0-9]{8}$/, // Cameroun
    '243': /^(243)?[89][0-9]{8}$/, // RDC
    // Congo-Brazzaville : mobile = 0 + [4/5/6] + 7 chiffres (MTN/Airtel),
    // préfixe pays 242 optionnel. (Avant : [0-9]{9} acceptait tout — B21.)
    '242': /^(242)?0?[456][0-9]{7}$/,
  };

  const pattern = patterns[countryCode] || /^[0-9]{9,15}$/;
  return pattern.test(cleaned);
}

export function formatMtnPhoneNumber(phoneNumber: string, countryCode: string = '242'): string {
  let formatted = phoneNumber.replace(/\s+/g, '').replace(/^\+/, '');

  if (!formatted.startsWith(countryCode)) {
    formatted = countryCode + formatted;
  }

  return formatted;
}
