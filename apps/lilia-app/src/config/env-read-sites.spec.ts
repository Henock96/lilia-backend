import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { envValidationSchema } from './env.validation';

/**
 * Toute variable **lue par le code** doit être déclarée dans le schéma Joi.
 *
 * ## Le trou que ce test ferme
 *
 * `env-example-parity.spec.ts` compare le schéma à `.env.example`. C'est utile,
 * mais aveugle à une variable absente des **deux** — et c'est précisément ce
 * qui est arrivé à `REDIS_COMMAND_TIMEOUT_MS`,
 * `REDIS_THROTTLER_COMMAND_TIMEOUT_MS` et `REDIS_CONNECT_TIMEOUT_MS` :
 * `buildRedisOptions` les lit, leur en-tête les présente comme le levier à
 * poser sur Render « sans attendre un redéploiement », et elles n'étaient
 * documentées nulle part. Un levier introuvable le jour de l'incident n'est pas
 * un levier.
 *
 * Deux conséquences, pas une : l'opérateur ne peut pas les découvrir, et
 * `.unknown(true)` fait que personne ne valide leur valeur.
 *
 * ## Ce qui est délibérément exclu
 *
 * Les variables **fournies par la plateforme** : on ne les provisionne pas, on
 * les lit. Les déclarer au schéma laisserait croire qu'on les contrôle.
 */
const PLATFORM_PROVIDED = new Set([
  // Render
  'RENDER_SERVICE_NAME',
  'RENDER_GIT_COMMIT',
  // Node / outillage
  'NODE_ENV',
  'PORT',
  'npm_package_version',
  // Sentry CLI (scripts de release, jamais lus à l'exécution)
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'SENTRY_RELEASE',
  // Poseé par les tests eux-mêmes
  'JEST_WORKER_ID',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts') && !full.includes('.spec.')) {
      out.push(full);
    }
  }
  return out;
}

describe('variables d’environnement ↔ sites de lecture', () => {
  const schemaKeys = new Set(
    Object.keys(envValidationSchema.describe().keys ?? {}),
  );

  /**
   * `process.env.X`, `process.env['X']`, `config.get<T>('X')`.
   *
   * ⚠️ Le receveur du `.get()` doit ressembler à une `ConfigService` : un
   * `Map.get('MANUAL')` — il y en a trois dans `payment-provider.registry.ts` —
   * n'est pas une lecture d'environnement.
   *
   * ⚠️ **Limite assumée** : une lecture dont la clé est une *variable* est
   * invisible ici. `buildRedisOptions` fait exactement cela
   * (`config.get(key, fallback)` où `key` est un paramètre), et c'est pour ça
   * que les trois délais Redis avaient échappé à tout le monde. Ce test ne les
   * rattrape pas ; il empêche la prochaine lecture **littérale** de dériver, et
   * `env-example-parity.spec.ts` protège désormais celles-là une fois
   * déclarées.
   */
  function readsIn(rawSource: string): string[] {
    // Les commentaires ne sont pas des sites de lecture. Sans ce nettoyage, un
    // `process.env.X` cité dans une explication est compté comme une variable
    // réellement lue — et le test réclame de déclarer une variable qui n'existe
    // pas. Un test qui crie à tort finit ignoré.
    const source = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const keys = new Set<string>();
    const patterns = [
      /process\.env\.([A-Z][A-Z0-9_]*)/g,
      /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
      /\b(?:config|configService|cfg)\.get(?:OrThrow)?\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) keys.add(m[1]);
    }
    return [...keys];
  }

  const readSites = (() => {
    const found = new Map<string, string[]>();
    for (const root of ['apps/lilia-app/src', 'apps/worker/src']) {
      for (const file of sourceFiles(join(process.cwd(), root))) {
        for (const key of readsIn(readFileSync(file, 'utf8'))) {
          if (!found.has(key)) found.set(key, []);
          found.get(key)!.push(file.replace(`${process.cwd()}/`, ''));
        }
      }
    }
    return found;
  })();

  it('déclare au schéma toutes les variables que le code lit', () => {
    const undeclared = [...readSites.entries()]
      .filter(([key]) => !schemaKeys.has(key) && !PLATFORM_PROVIDED.has(key))
      .map(([key, files]) => `${key} (lu dans ${files[0]})`)
      .sort();

    // Message explicite : on veut lire QUELLE variable manque et OÙ, pas un
    // compteur.
    expect({ nonDeclarees: undeclared }).toEqual({ nonDeclarees: [] });
  });

  it('trouve bien les sites de lecture (garde contre un balayage vide)', () => {
    // Sans cette garde, une erreur de chemin rendrait le test précédent vert
    // pour la pire des raisons : il n'aurait rien inspecté.
    expect(readSites.size).toBeGreaterThan(20);
    expect(readSites.has('DATABASE_URL')).toBe(true);
  });
});
