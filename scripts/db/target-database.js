/**
 * À quelle base parle-t-on, et a-t-on le droit d'y écrire ?
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * Le `.env` de ce dépôt porte le `DATABASE_URL` de **production** (Neon,
 * 54 clients, 117 commandes réelles). C'est commode — on interroge la vraie
 * base sans rien configurer — et c'est exactement ce qui rend un accident
 * possible : `npm run db:reset:dev`, un `prisma migrate reset`, ou
 * `delete-vendor.js --commit` frappent la production sans qu'aucune étape ne
 * demande confirmation. Aucun de ces gestes n'est réversible sans restauration
 * de sauvegarde.
 *
 * LA RÈGLE, FAIL-CLOSED
 *
 * Toute base dont l'hôte n'est **pas** local est considérée comme de la
 * production. Ce n'est pas une devinette prudente, c'est le bon défaut : se
 * tromper dans ce sens coûte une variable d'environnement à poser ; se tromper
 * dans l'autre coûte la base.
 *
 * L'échappatoire est explicite, nominative et à usage unique :
 *
 *   LILIA_ALLOW_PRODUCTION_WRITES=oui-je-sais-ce-que-je-fais node scripts/…
 *
 * Elle est volontairement pénible à taper. Une garde qu'on désarme par
 * `--force` finit dans l'historique du shell et se rejoue par flèche haut.
 */

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'host.docker.internal',
  'postgres', // service docker-compose / CI
  'db',
]);

const OVERRIDE = 'oui-je-sais-ce-que-je-fais';

/**
 * Décrit la cible sans jamais rendre le mot de passe.
 *
 * @param {string} [url] — `DATABASE_URL` par défaut.
 */
function describeTarget(url = process.env.DATABASE_URL) {
  if (!url) {
    return {
      ok: false,
      isLocal: false,
      host: null,
      database: null,
      label: 'DATABASE_URL absent',
    };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Une URL illisible n'est pas une URL locale : on ne relâche jamais la
    // garde sur une erreur d'analyse.
    return {
      ok: false,
      isLocal: false,
      host: null,
      database: null,
      label: 'DATABASE_URL illisible',
    };
  }

  const host = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, '') || null;
  const isLocal = LOCAL_HOSTS.has(host);

  return {
    ok: true,
    isLocal,
    host,
    database,
    label: `${host}/${database ?? '?'}`,
  };
}

/** L'échappatoire explicite est-elle armée ? */
function overrideArmed() {
  return process.env.LILIA_ALLOW_PRODUCTION_WRITES === OVERRIDE;
}

/**
 * Refuse une écriture sur une base non locale.
 *
 * @param {string} operation — décrit le geste, repris dans le message.
 * @param {{ exit?: boolean }} [opts] — `exit: false` pour lever au lieu de
 *   quitter (utilisé par les tests).
 */
function assertLocalDatabase(operation, opts = {}) {
  const target = describeTarget();

  if (target.isLocal) return target;

  if (overrideArmed()) {
    process.stderr.write(
      `⚠️  ${operation} sur une base NON LOCALE (${target.label}) — ` +
        `garde levée par LILIA_ALLOW_PRODUCTION_WRITES.\n`,
    );
    return target;
  }

  const message =
    `\n🛑 REFUS — ${operation}\n\n` +
    `   Base visée : ${target.label}\n` +
    `   Ce n'est pas une base locale. Par défaut, toute base distante est\n` +
    `   traitée comme la PRODUCTION.\n\n` +
    `   Pour travailler en local, pointez DATABASE_URL sur votre PostgreSQL :\n` +
    `     DATABASE_URL="postgresql://localhost:5432/lilia_dev"\n\n` +
    `   Si vous visez réellement cette base, en connaissance de cause :\n` +
    `     LILIA_ALLOW_PRODUCTION_WRITES=${OVERRIDE} <commande>\n`;

  if (opts.exit === false) throw new Error(message);
  process.stderr.write(message);
  process.exit(1);
}

module.exports = {
  describeTarget,
  assertLocalDatabase,
  overrideArmed,
  LOCAL_HOSTS,
  OVERRIDE,
};
