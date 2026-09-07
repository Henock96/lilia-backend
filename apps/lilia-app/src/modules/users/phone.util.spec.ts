import { normalizePhone } from './phone.util';

/**
 * Normalisation des numéros — socle du signal anti-abus `PHONE_REUSED`.
 *
 * Sans elle, `06 12 34 56 78`, `+242 06 12345678` et `242061234567` seraient
 * trois personnes différentes. Un fraudeur n'a aucune raison de saisir deux
 * fois la même forme, donc la comparaison brute ne repérerait rien.
 */
describe('normalizePhone', () => {
  it('rapproche les écritures d’un même numéro congolais', () => {
    const forms = [
      '061234567',
      '06 12 34 567',
      '06-12-34-567',
      '+242 06 12 34 567',
      '+242061234567',
      '00242061234567',
      '242061234567',
      '(06) 12.34.567',
    ];

    const normalized = forms.map(normalizePhone);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('61234567');
  });

  it('distingue deux numéros réellement différents', () => {
    expect(normalizePhone('061234567')).not.toBe(normalizePhone('069999999'));
  });

  it('rend null pour une valeur absente ou vide', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('')).toBeNull();
    // La chaîne vide historique — c'est elle qui rendait tous les comptes sans
    // téléphone « porteurs du même numéro ».
    expect(normalizePhone('   ')).toBeNull();
  });

  it('rend null plutôt qu’une valeur trop courte', () => {
    // Un « 0 » seul ou « 12 » ne sont pas des numéros. Les normaliser ferait
    // collisionner des comptes sans rapport — un faux positif de fraude bien
    // pire que l'absence de signal.
    expect(normalizePhone('0')).toBeNull();
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('+242')).toBeNull();
  });

  it('ne retire pas le zéro s’il ne reste rien derrière', () => {
    expect(normalizePhone('0')).toBeNull();
  });

  it('ignore la ponctuation et les espaces insécables', () => {
    expect(normalizePhone('06 12 34 567')).toBe('61234567');
  });
});
