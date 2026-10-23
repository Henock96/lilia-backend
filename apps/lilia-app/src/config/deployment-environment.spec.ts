import {
  isDeployedEnvironment,
  resolveCorsOrigin,
} from './deployment-environment';

/**
 * Une préproduction porte une copie des données de production et accepte les
 * vrais comptes Firebase : elle s'expose comme la production, pas comme un
 * poste de développement.
 */
describe('isDeployedEnvironment', () => {
  it.each(['production', 'staging'])(
    '%s est un environnement déployé',
    (env) => {
      expect(isDeployedEnvironment(env)).toBe(true);
    },
  );

  it.each(['development', 'test', undefined, ''])('%p ne l’est pas', (env) => {
    expect(isDeployedEnvironment(env)).toBe(false);
  });
});

describe('resolveCorsOrigin', () => {
  it('en préproduction, applique la liste blanche', () => {
    expect(
      resolveCorsOrigin('staging', ' https://a.test , https://b.test ,'),
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('en production, applique la liste blanche', () => {
    expect(resolveCorsOrigin('production', 'https://a.test')).toEqual([
      'https://a.test',
    ]);
  });

  it.each(['staging', 'production'])(
    'en %s, refuse de démarrer sans liste blanche',
    (env) => {
      // Refléter toute origine avec `credentials: true` sur une base qui
      // contient de vraies sessions serait une faille, pas un confort.
      expect(() => resolveCorsOrigin(env, undefined)).toThrow(
        /ALLOWED_ORIGINS/,
      );
      expect(() => resolveCorsOrigin(env, ' , ')).toThrow(/ALLOWED_ORIGINS/);
    },
  );

  it('en développement, autorise toute origine', () => {
    expect(resolveCorsOrigin('development', undefined)).toBe(true);
    expect(resolveCorsOrigin(undefined, 'https://a.test')).toBe(true);
  });
});
