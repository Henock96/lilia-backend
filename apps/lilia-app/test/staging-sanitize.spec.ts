/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Garde de `scripts/db/staging-sanitize.js`.
 *
 * Ce script réécrit les données personnelles d'une base entière. Exécuté sur
 * la production, il détruirait les téléphones de versement et les adresses de
 * tous les clients. Il n'accepte donc que deux cibles : une base locale, ou une
 * base **déclarée** préproduction (hôte listé) **et marquée** comme telle dans
 * la base elle-même (`COMMENT ON DATABASE`). Une branche Neon créée depuis la
 * prod n'a pas la marque tant qu'on ne l'a pas posée : se tromper d'hôte ne
 * suffit pas à frapper la prod.
 */
const { checkTarget, STAGING_MARKER } =
  require('../../../scripts/db/staging-sanitize') as {
    checkTarget: (
      target: { ok: boolean; isLocal: boolean; isStaging: boolean },
      marker: string | null,
    ) => { ok: boolean; reason: string };
    STAGING_MARKER: string;
  };

const LOCAL = { ok: true, isLocal: true, isStaging: false };
const STAGING = { ok: true, isLocal: false, isStaging: true };
const REMOTE = { ok: true, isLocal: false, isStaging: false };

describe('staging-sanitize — checkTarget', () => {
  it('accepte une base locale, sans marque', () => {
    expect(checkTarget(LOCAL, null).ok).toBe(true);
  });

  it('accepte la préproduction déclarée et marquée', () => {
    expect(checkTarget(STAGING, STAGING_MARKER).ok).toBe(true);
  });

  it('refuse la préproduction déclarée mais non marquée', () => {
    const r = checkTarget(STAGING, null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/COMMENT ON DATABASE/);
    expect(checkTarget(STAGING, 'autre chose').ok).toBe(false);
  });

  it('refuse toute base distante non déclarée, même marquée', () => {
    expect(checkTarget(REMOTE, STAGING_MARKER).ok).toBe(false);
  });

  it('refuse une URL absente ou illisible', () => {
    expect(
      checkTarget({ ok: false, isLocal: false, isStaging: false }, null).ok,
    ).toBe(false);
  });
});
