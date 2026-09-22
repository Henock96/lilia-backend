import { readSampleRate, readOptionalText } from './env-readers';

/**
 * Lectures d'environnement faites **avant** que Joi n'ait validé quoi que ce
 * soit.
 *
 * ## Pourquoi ces helpers existent
 *
 * `instrument.ts` doit être le tout premier import de `main.ts` — Sentry
 * s'installe avant que les autres modules ne soient chargés. Il s'exécute donc
 * **bien avant** `ConfigModule`, et ne bénéficie d'aucune validation : ni des
 * bornes du schéma, ni de la convention `.empty('')` qui traduit « vide » en
 * « non posée ».
 *
 * Or `.env.example` documente désormais `SENTRY_TRACES_SAMPLE_RATE=` vide.
 * `process.env.X ?? '0.1'` ne rattrape que `undefined` : une variable posée
 * mais vide donne `''`, et `parseFloat('')` vaut `NaN`. Sentry refuse un taux
 * non numérique et **abandonne toutes les transactions** — le traçage s'éteint
 * en silence, au lieu de valoir les 0,1 annoncés. Le fichier censé aider un
 * opérateur lui apprenait donc à éteindre le traçage.
 */
describe('readSampleRate', () => {
  it('lit une fraction valide', () => {
    expect(readSampleRate('0.25', 0.1)).toBe(0.25);
  });

  it('retombe sur le défaut quand la variable est absente', () => {
    expect(readSampleRate(undefined, 0.1)).toBe(0.1);
  });

  it('retombe sur le défaut quand la variable est VIDE', () => {
    // La forme que `.env.example` enseigne : `SENTRY_TRACES_SAMPLE_RATE=`.
    expect(readSampleRate('', 0.1)).toBe(0.1);
  });

  it('retombe sur le défaut plutôt que de rendre NaN', () => {
    expect(readSampleRate('beaucoup', 0.1)).toBe(0.1);
  });

  it('refuse un pourcentage saisi à la place d’une fraction', () => {
    // `10` au lieu de `0.1` tracerait dix fois chaque requête si Sentry
    // l'acceptait. Hors [0,1] ⇒ défaut.
    expect(readSampleRate('10', 0.1)).toBe(0.1);
    expect(readSampleRate('-1', 0.1)).toBe(0.1);
  });

  it('accepte les bornes', () => {
    expect(readSampleRate('0', 0.1)).toBe(0);
    expect(readSampleRate('1', 0.1)).toBe(1);
  });
});

describe('readOptionalText', () => {
  it('rend la valeur posée', () => {
    expect(readOptionalText('staging')).toBe('staging');
  });

  it('traite une chaîne vide comme absente', () => {
    // Sans quoi `environment: '' ` remplacerait le repli sur `NODE_ENV`, et
    // Sentry rangerait les événements sous un environnement sans nom.
    expect(readOptionalText('')).toBeUndefined();
    expect(readOptionalText('   ')).toBeUndefined();
  });

  it('rend undefined quand la variable est absente', () => {
    expect(readOptionalText(undefined)).toBeUndefined();
  });
});
