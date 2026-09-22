/**
 * Politique du canal de mise à jour du parc mobile — **l'autorité**.
 *
 * Trois implémentations de ces règles existent : celle-ci, `app_update_rules.dart`
 * (Admin Flutter) et `apps/admin/lib/app-update-rules.ts` (Admin Web, lilia-food-web). Les
 * deux interfaces ne font que de l'UX — prévenir une erreur avant l'aller-retour.
 * **C'est ce fichier qui décide** : une configuration qu'il refuse ne peut pas
 * être écrite, quelle que soit l'interface (ou le curl) qui l'envoie.
 *
 * Avant l'audit du 22/09/2026 (SET-002), le DTO validait chaque champ isolément
 * et les invariants croisés — « un blocage exige une dernière version », « on
 * n'exige pas une version que personne ne peut installer » — ne vivaient que
 * dans l'écran Flutter. Un PATCH partiel pouvait donc produire un blocage
 * invérifiable.
 */

/**
 * Version acceptée à l'**écriture** : `major.minor.patch`, `+build` optionnel.
 *
 * Plus strict que le parseur des applications (qui tolère un « v » initial et
 * des espaces) : exigeant sur ce qu'on enregistre, tolérant sur ce qu'on reçoit.
 * Le sens ne doit jamais s'inverser — accepter ici une forme que les clients
 * ignorent ferait croire à l'administrateur qu'il a posé un seuil inexistant.
 */
export const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(\+\d+)?$/;

export interface AppVersion {
  major: number;
  minor: number;
  patch: number;
  /** `null` = build **absent**, pas build zéro. Voir [compareAppVersions]. */
  build: number | null;
}

/** Parse strictement, ou `null`. `1.2` n'est jamais promu en `1.2.0`. */
export function parseAppVersion(
  input: string | null | undefined,
): AppVersion | null {
  if (typeof input !== 'string' || !APP_VERSION_PATTERN.test(input)) {
    return null;
  }
  const [core, build] = input.split('+');
  const [major, minor, patch] = core.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const buildNumber = build === undefined ? null : Number(build);
  if (buildNumber !== null && !Number.isSafeInteger(buildNumber)) return null;
  return { major, minor, patch, build: buildNumber };
}

/**
 * Ordre : majeure, mineure, correctif, **numériquement** (1.10.0 > 1.9.0), puis
 * build — mais seulement si les **deux** versions en portent un. `1.3.0` et
 * `1.3.0+34` sont égales : un seuil sans build signifie « n'importe quel build ».
 *
 * Recopie exacte de `AppVersion.compareTo` (lilia-app), qui applique réellement
 * le seuil sur le téléphone.
 */
export function compareAppVersions(a: AppVersion, b: AppVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.build === null || b.build === null) return 0;
  return a.build - b.build;
}

export function formatAppVersion(v: AppVersion): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.build === null ? core : `${core}+${v.build}`;
}

// ── Destinations de store ─────────────────────────────────────────────────

/**
 * `applicationId` réel de l'app client (`lilia-app/android/app/build.gradle.kts`).
 *
 * Épinglé plutôt que « n'importe quelle fiche Play » : le site a déjà pointé
 * vers `com.lilia.food`, un identifiant inexistant. Une fiche Play valide mais
 * qui n'est pas la nôtre enferme l'utilisateur dans un blocage exactement comme
 * une URL cassée. Si l'identifiant change côté app, il change ici.
 */
export const ANDROID_APPLICATION_ID = 'com.dreesis.lilia.lilia_app';

/**
 * Identifiants App Store connus pour être des **gabarits** qui ont circulé dans
 * le code (`id6740000000` en repli de `lilia-app`, `id000000000` sur le site).
 * Ils ont la forme d'un vrai identifiant et mènent à une fiche inexistante.
 */
const KNOWN_PLACEHOLDER_APP_STORE_IDS = new Set(['6740000000', '000000000']);

function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Refuse identifiants, port et fragments : rien de tout cela n'a sa place ici. */
function hasNoExtras(url: URL): boolean {
  return url.username === '' && url.password === '' && url.port === '';
}

/**
 * Destinations Android acceptées — la fiche de **notre** application :
 *
 * - `https://play.google.com/store/apps/details?id=com.dreesis.lilia.lilia_app`
 *   (paramètres supplémentaires tolérés, ex. `&hl=fr`) ;
 * - `market://details?id=com.dreesis.lilia.lilia_app`.
 */
export function isAllowedAndroidStoreUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  const url = safeParseUrl(raw);
  if (!url || !hasNoExtras(url)) return false;
  const id = url.searchParams.get('id');
  if (id !== ANDROID_APPLICATION_ID) return false;

  if (url.protocol === 'https:') {
    return (
      url.hostname === 'play.google.com' &&
      url.pathname === '/store/apps/details'
    );
  }
  if (url.protocol === 'market:') {
    // WHATWG lit `market://details?id=…` avec `details` comme hôte.
    return (
      url.hostname === 'details' &&
      (url.pathname === '' || url.pathname === '/')
    );
  }
  return false;
}

/**
 * Destinations iOS acceptées — une **fiche** d'application, jamais une
 * recherche ni un domaine tiers :
 *
 * - `https://apps.apple.com/[cc/]app/[slug/]id<9-10 chiffres>` ;
 * - `itms-apps://apps.apple.com/…` ou `itms-apps://itunes.apple.com/…`, même chemin.
 *
 * Les identifiants de gabarit connus sont refusés.
 */
export function isAllowedIosStoreUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  const url = safeParseUrl(raw);
  if (!url || !hasNoExtras(url)) return false;

  const hostOk =
    (url.protocol === 'https:' && url.hostname === 'apps.apple.com') ||
    (url.protocol === 'itms-apps:' &&
      (url.hostname === 'apps.apple.com' ||
        url.hostname === 'itunes.apple.com'));
  if (!hostOk) return false;

  const match = /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id(\d{9,10})\/?$/.exec(
    url.pathname,
  );
  if (!match) return false;
  return !KNOWN_PLACEHOLDER_APP_STORE_IDS.has(match[1]);
}

// ── Invariants croisés ────────────────────────────────────────────────────

export interface AppUpdateVersions {
  minAppVersion: string | null;
  latestAppVersion: string | null;
}

/**
 * Refus, en français, pour l'état **résultant** (valeurs envoyées fusionnées
 * avec celles déjà en base). Liste vide = état acceptable.
 *
 * Mêmes règles, mêmes cas que `validateAppUpdate` (Admin Flutter) :
 * 1. un blocage exige une dernière version publiée — sans elle, impossible de
 *    vérifier qu'il est installable ;
 * 2. `min` avec build contre `latest` sans build est **indécidable** — refusé ;
 * 3. `min` ne dépasse jamais `latest` — on exigerait une version introuvable.
 */
export function appUpdateViolations(state: AppUpdateVersions): string[] {
  const min = parseAppVersion(state.minAppVersion);
  const latest = parseAppVersion(state.latestAppVersion);

  if (min === null) return [];

  if (latest === null) {
    return [
      'Une version minimale exige une dernière version publiée : sans elle, ' +
        'impossible de vérifier que le blocage est installable.',
    ];
  }
  if (min.build !== null && latest.build === null) {
    return [
      `Blocage invérifiable : la version minimale exige un build ` +
        `(${formatAppVersion(min)}) alors que la dernière version publiée n'en ` +
        `déclare aucun (${formatAppVersion(latest)}).`,
    ];
  }
  if (compareAppVersions(min, latest) > 0) {
    return [
      `La version minimale (${formatAppVersion(min)}) dépasse la dernière ` +
        `version publiée (${formatAppVersion(latest)}) : aucun utilisateur ne ` +
        `pourrait l'installer.`,
    ];
  }
  return [];
}
