/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Extraction de l'expression d'un CHECK depuis `pg_get_constraintdef`.
 *
 * C'est la seule transformation de texte de `validate-check-constraints.js` :
 * une expression mal extraite ferait compter les violations sur autre chose
 * que la contrainte, sans aucune erreur.
 */
const { extractCheckExpression } =
  require('../../../scripts/db/validate-check-constraints') as {
    extractCheckExpression: (definition: string) => string;
  };

describe('extractCheckExpression', () => {
  it('retire CHECK et NOT VALID, garde les parenthèses extérieures', () => {
    expect(extractCheckExpression('CHECK ((amount > 0)) NOT VALID')).toBe(
      '((amount > 0))',
    );
  });

  it('accepte une contrainte déjà validée (sans NOT VALID)', () => {
    expect(extractCheckExpression('CHECK ((attempts >= 0))')).toBe(
      '((attempts >= 0))',
    );
  });

  it('conserve une expression multi-lignes avec IS NULL et OR', () => {
    const def =
      'CHECK ((("prixOriginal" >= 0) AND (("stockRestant" IS NULL) OR ("stockRestant" >= 0)))) NOT VALID';
    expect(extractCheckExpression(def)).toBe(
      '((("prixOriginal" >= 0) AND (("stockRestant" IS NULL) OR ("stockRestant" >= 0))))',
    );
  });

  it('ne confond pas « NOT VALID » avec une expression qui contient NOT', () => {
    expect(extractCheckExpression('CHECK ((NOT (x IS NULL))) NOT VALID')).toBe(
      '((NOT (x IS NULL)))',
    );
  });

  it('refuse une définition qui n’est pas un CHECK', () => {
    expect(() =>
      extractCheckExpression('FOREIGN KEY (a) REFERENCES b(id)'),
    ).toThrow(/inattendue/);
  });
});
