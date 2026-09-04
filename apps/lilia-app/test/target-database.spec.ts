/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Garde « ne jamais écrire sur la production par accident ».
 *
 * Le `.env` de ce dépôt porte le `DATABASE_URL` de production. Une commande
 * comme `db:reset:dev` y frappait donc directement, sans confirmation et sans
 * retour arrière. Cette suite fixe la règle : **toute base non locale est
 * traitée comme la production**, et l'échappatoire doit être explicite.
 */
const guard = require('../../../scripts/db/target-database');

const { describeTarget, assertLocalDatabase, OVERRIDE } = guard as {
  describeTarget: (url?: string) => {
    ok: boolean;
    isLocal: boolean;
    host: string | null;
    database: string | null;
    label: string;
  };
  assertLocalDatabase: (
    operation: string,
    opts?: { exit?: boolean },
  ) => unknown;
  OVERRIDE: string;
};

/**
 * Hôte distant fictif, à la forme d'une URL Neon.
 *
 * ⚠️ **Ne pas y remettre l'endpoint réel de production.** Ce dépôt est public,
 * et l'adresse d'une base de données n'a pas à y être publiée — même sans mot
 * de passe. Ce que la garde examine est l'**hôte**, pas son identité : n'importe
 * quel nom non local fait l'affaire.
 */
const PROD_URL =
  'postgresql://user:s3cret@ep-exemple-0000.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require';

describe('describeTarget', () => {
  it('reconnaît une base locale', () => {
    const t = describeTarget('postgresql://localhost:5432/lilia_dev');
    expect(t.isLocal).toBe(true);
    expect(t.label).toBe('localhost/lilia_dev');
  });

  it('reconnaît 127.0.0.1 et le service docker/CI', () => {
    expect(describeTarget('postgresql://127.0.0.1:5432/x').isLocal).toBe(true);
    expect(describeTarget('postgresql://postgres:5432/x').isLocal).toBe(true);
  });

  it('traite la base Neon de production comme non locale', () => {
    const t = describeTarget(PROD_URL);
    expect(t.isLocal).toBe(false);
    expect(t.database).toBe('neondb');
  });

  it('ne rend jamais le mot de passe', () => {
    expect(JSON.stringify(describeTarget(PROD_URL))).not.toContain('s3cret');
  });

  it('une URL illisible n’est PAS considérée comme locale', () => {
    // Fail-closed : on ne relâche pas la garde sur une erreur d'analyse.
    expect(describeTarget('pas-une-url').isLocal).toBe(false);
    expect(describeTarget('pas-une-url').ok).toBe(false);
  });

  it('une URL vide n’est PAS considérée comme locale', () => {
    // `''` est falsy : la valeur par défaut ne s'applique pas, c'est bien la
    // branche « absent » qui est prise.
    expect(describeTarget('').isLocal).toBe(false);
    expect(describeTarget('').ok).toBe(false);
  });

  it('sans argument, retombe sur DATABASE_URL', () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = PROD_URL;
    expect(describeTarget().isLocal).toBe(false);
    process.env.DATABASE_URL = saved;
  });
});

describe('assertLocalDatabase', () => {
  const saved = {
    url: process.env.DATABASE_URL,
    ov: process.env.LILIA_ALLOW_PRODUCTION_WRITES,
  };

  afterEach(() => {
    process.env.DATABASE_URL = saved.url;
    if (saved.ov === undefined)
      delete process.env.LILIA_ALLOW_PRODUCTION_WRITES;
    else process.env.LILIA_ALLOW_PRODUCTION_WRITES = saved.ov;
  });

  it('laisse passer une base locale', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/lilia_dev';
    delete process.env.LILIA_ALLOW_PRODUCTION_WRITES;
    expect(() => assertLocalDatabase('reset', { exit: false })).not.toThrow();
  });

  it('refuse une base distante', () => {
    process.env.DATABASE_URL = PROD_URL;
    delete process.env.LILIA_ALLOW_PRODUCTION_WRITES;
    expect(() => assertLocalDatabase('reset', { exit: false })).toThrow(
      /REFUS/,
    );
  });

  it('refuse aussi quand DATABASE_URL est absent', () => {
    delete process.env.DATABASE_URL;
    delete process.env.LILIA_ALLOW_PRODUCTION_WRITES;
    expect(() => assertLocalDatabase('reset', { exit: false })).toThrow();
  });

  it('l’échappatoire doit être exacte — un « true » ne suffit pas', () => {
    process.env.DATABASE_URL = PROD_URL;
    process.env.LILIA_ALLOW_PRODUCTION_WRITES = 'true';
    expect(() => assertLocalDatabase('reset', { exit: false })).toThrow();

    process.env.LILIA_ALLOW_PRODUCTION_WRITES = '1';
    expect(() => assertLocalDatabase('reset', { exit: false })).toThrow();
  });

  it('l’échappatoire explicite lève la garde', () => {
    process.env.DATABASE_URL = PROD_URL;
    process.env.LILIA_ALLOW_PRODUCTION_WRITES = OVERRIDE;
    const spy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => assertLocalDatabase('reset', { exit: false })).not.toThrow();
    // Elle prévient, elle ne se tait pas.
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('NON LOCALE'));
    spy.mockRestore();
  });
});
