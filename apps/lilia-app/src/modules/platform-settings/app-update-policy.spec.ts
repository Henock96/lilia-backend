import {
  ANDROID_APPLICATION_ID,
  appUpdateViolations,
  compareAppVersions,
  isAllowedAndroidStoreUrl,
  isAllowedIosStoreUrl,
  parseAppVersion,
} from './app-update-policy';

/**
 * Politique du canal de mise à jour — l'autorité côté serveur.
 *
 * Les vecteurs de version et d'invariants sont **les mêmes** que ceux de
 * `app_update_rules_test.dart` (Admin Flutter), `app_version_test.dart`
 * (lilia-app) et `app-update-rules.test.ts` (Admin Web). Si l'un de ces
 * fichiers change de verdict sur un cas, les trois autres doivent suivre.
 */
describe('app-update-policy', () => {
  const v = (s: string) => {
    const parsed = parseAppVersion(s);
    if (!parsed) throw new Error(`version de test illisible : ${s}`);
    return parsed;
  };

  describe('parseAppVersion', () => {
    it.each(['1.2.0', '1.3.0', '1.10.0', '2.0.0', '1.3.0+34', '0.0.1+1'])(
      'lit %s',
      (s) => expect(parseAppVersion(s)).not.toBeNull(),
    );

    it.each([
      '1.3',
      '1.3.0-beta',
      'v1.3.0',
      ' 1.3.0',
      '1.3.0+',
      '1.3.0.4',
      'abc',
      '',
      null,
      undefined,
    ])('refuse %p', (s) => expect(parseAppVersion(s)).toBeNull());

    it('distingue « pas de build » de « build 0 »', () => {
      expect(v('1.3.0').build).toBeNull();
      expect(v('1.3.0+0').build).toBe(0);
    });
  });

  describe('compareAppVersions', () => {
    it.each([
      ['1.2.0', '1.3.0'],
      ['1.3.0', '1.9.0'],
      ['1.9.0', '1.10.0'], // numérique, pas lexicographique
      ['1.10.0', '2.0.0'],
      ['1.3.0+34', '1.3.0+35'],
      ['1.3.0+35', '1.3.0+40'],
    ])('%s < %s', (a, b) => {
      expect(compareAppVersions(v(a), v(b))).toBeLessThan(0);
      expect(compareAppVersions(v(b), v(a))).toBeGreaterThan(0);
    });

    it('le build ne départage que si les deux versions en portent un', () => {
      expect(compareAppVersions(v('1.3.0'), v('1.3.0+34'))).toBe(0);
      expect(compareAppVersions(v('1.3.0+34'), v('1.3.0'))).toBe(0);
    });
  });

  describe('isAllowedAndroidStoreUrl', () => {
    it.each([
      `https://play.google.com/store/apps/details?id=${ANDROID_APPLICATION_ID}`,
      `https://play.google.com/store/apps/details?id=${ANDROID_APPLICATION_ID}&hl=fr`,
      `market://details?id=${ANDROID_APPLICATION_ID}`,
    ])('accepte %s', (url) => expect(isAllowedAndroidStoreUrl(url)).toBe(true));

    it.each([
      [
        'domaine tiers',
        `https://example.com/store/apps/details?id=${ANDROID_APPLICATION_ID}`,
      ],
      [
        'autre application',
        'https://play.google.com/store/apps/details?id=com.lilia.food',
      ],
      ['sans identifiant', 'https://play.google.com/store/apps/details'],
      [
        'http en clair',
        `http://play.google.com/store/apps/details?id=${ANDROID_APPLICATION_ID}`,
      ],
      ['recherche', 'https://play.google.com/store/search?q=lilia'],
      [
        'hôte usurpé par userinfo',
        `https://play.google.com@evil.com/store/apps/details?id=${ANDROID_APPLICATION_ID}`,
      ],
      [
        'sous-domaine piège',
        `https://play.google.com.evil.com/store/apps/details?id=${ANDROID_APPLICATION_ID}`,
      ],
      ['javascript', 'javascript:alert(1)'],
      ['sans protocole', 'play.google.com/store/apps/details'],
      ['vide', ''],
    ])('refuse : %s', (_, url) =>
      expect(isAllowedAndroidStoreUrl(url)).toBe(false),
    );
  });

  describe('isAllowedIosStoreUrl', () => {
    it.each([
      'https://apps.apple.com/app/lilia-food/id1234567890',
      'https://apps.apple.com/fr/app/lilia-food/id1234567890',
      'https://apps.apple.com/app/id123456789',
      'itms-apps://apps.apple.com/app/id1234567890',
      'itms-apps://itunes.apple.com/app/id1234567890',
    ])('accepte %s', (url) => expect(isAllowedIosStoreUrl(url)).toBe(true));

    it.each([
      [
        'gabarit id6740000000',
        'https://apps.apple.com/app/lilia-food/id6740000000',
      ],
      [
        'gabarit id000000000',
        'https://apps.apple.com/app/lilia-food/id000000000',
      ],
      ['recherche', 'https://apps.apple.com/search?term=Lilia%20Food'],
      ['identifiant trop court', 'https://apps.apple.com/app/id123'],
      ['domaine tiers', 'https://example.com/app/lilia-food/id1234567890'],
      ['http en clair', 'http://apps.apple.com/app/id1234567890'],
      ['vide', ''],
    ])('refuse : %s', (_, url) =>
      expect(isAllowedIosStoreUrl(url)).toBe(false),
    );
  });

  describe('appUpdateViolations', () => {
    const state = (min: string | null, latest: string | null) =>
      appUpdateViolations({ minAppVersion: min, latestAppVersion: latest });

    it('aucun blocage : rien à vérifier', () => {
      expect(state(null, null)).toEqual([]);
      expect(state(null, '1.3.0')).toEqual([]);
    });

    it('un blocage exige une dernière version', () => {
      expect(state('1.3.0', null)).toHaveLength(1);
    });

    it('refuse min > latest', () => {
      expect(state('2.0.0', '1.3.0')).toHaveLength(1);
      expect(state('1.10.0', '1.9.0')).toHaveLength(1);
      expect(state('1.3.0+41', '1.3.0+40')).toHaveLength(1);
    });

    it('accepte min = latest (état de la prod au 22/09/2026)', () => {
      expect(state('1.3.0', '1.3.0')).toEqual([]);
    });

    it('accepte min < latest', () => {
      expect(state('1.3.0', '1.4.0')).toEqual([]);
      expect(state('1.9.0', '1.10.0')).toEqual([]);
    });

    it('refuse min avec build contre latest sans build (indécidable)', () => {
      expect(state('1.3.0+40', '1.3.0')).toHaveLength(1);
    });

    it('accepte min sans build contre latest avec build', () => {
      expect(state('1.3.0', '1.3.0+41')).toEqual([]);
    });
  });
});
