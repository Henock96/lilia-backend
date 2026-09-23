// Valide les contraintes CHECK posées en `NOT VALID` (L0-6, blueprint Phase 3).
//
// ## Pourquoi un script et pas une migration
//
// La migration `20260923130000_money_stock_check_constraints` pose 12 CHECK en
// `NOT VALID` : PostgreSQL les applique à toute écriture future sans scanner
// l'existant. Tant qu'elles ne sont pas validées, une ligne historique hors
// bornes reste possible — et surtout le planificateur ne peut pas s'appuyer
// dessus.
//
// Les valider dans une migration serait la mauvaise porte : une seule ligne
// historique en défaut ferait échouer `migrate deploy`, donc le déploiement
// entier, pour une question qui n'a rien d'urgent. D'où ce script, joué hors
// déploiement, contrainte par contrainte.
//
// ## Ce qu'il fait
//
// Lecture seule par défaut : pour chaque CHECK non validée du schéma `public`,
// il compte les lignes qui la violent (`(expression) IS FALSE` — un NULL ne
// viole pas un CHECK, exactement comme PostgreSQL le juge).
//
// `--apply` : valide **seulement** les contraintes à 0 violation, une par une
// (`ALTER TABLE … VALIDATE CONSTRAINT`, verrou SHARE UPDATE EXCLUSIVE,
// compatible avec les lectures et écritures). Une contrainte violée n'est
// jamais touchée : elle est listée, à corriger d'abord.
//
// Générique à dessein : la Phase 3 posera d'autres CHECK `NOT VALID`
// (tarifs, ledger vendeur, stock par variante) ; le même script les validera.
//
// ## Usage
//
//   npm run db:target                                        # quelle base ?
//   node scripts/db/validate-check-constraints.js            # diagnostic
//   node scripts/db/validate-check-constraints.js --apply    # base locale
//   LILIA_ALLOW_PRODUCTION_WRITES=oui-je-sais-ce-que-je-fais \
//     node scripts/db/validate-check-constraints.js --apply  # production
//
// Rollback : aucun n'est nécessaire — valider ne modifie aucune donnée. Pour
// revenir à l'état précédent : `ALTER TABLE … DROP CONSTRAINT …` puis la
// reposer en `NOT VALID`.

// `loadEnv()` est appelé dans `main()`, pas au chargement : le test unitaire
// importe `extractCheckExpression` sans jamais résoudre de base.
const { loadEnv } = require('../load-env');
const { Client } = require('pg');
const { describeTarget, assertLocalDatabase } = require('./target-database');

const APPLY = process.argv.includes('--apply');

const PENDING_CHECKS_SQL = `
  SELECT c.conname                    AS name,
         c.conrelid::regclass::text   AS "table",
         pg_get_constraintdef(c.oid)  AS definition
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE c.contype = 'c'
     AND NOT c.convalidated
     AND n.nspname = 'public'
   ORDER BY 2, 1
`;

/**
 * `CHECK ((a >= 0)) NOT VALID` → `((a >= 0))` (parenthèses gardées : sûres à réinjecter).
 *
 * Exporté pour les tests : c'est la seule transformation de texte du script,
 * et une expression mal extraite compterait faux sans erreur.
 */
function extractCheckExpression(definition) {
  const match = /^CHECK\s*(\(.*\))(?:\s+NOT VALID)?\s*$/s.exec(definition.trim());
  if (!match) throw new Error(`Définition CHECK inattendue : ${definition}`);
  return match[1];
}

async function main() {
  // Même cascade que l'application (.env.local → .env.<NODE_ENV> → .env) ;
  // la base réellement atteinte est ensuite NOMMÉE par describeTarget().
  loadEnv();
  const target = describeTarget();
  process.stdout.write(
    `\nBase ciblée : ${target.label}${target.isLocal ? '' : '  ⚠️  NON LOCALE'}\n` +
      `Mode : ${APPLY ? 'VALIDATION (--apply)' : 'diagnostic, lecture seule'}\n\n`,
  );
  if (APPLY) assertLocalDatabase('VALIDATE CONSTRAINT des CHECK NOT VALID');

  const reader = new Client({ connectionString: process.env.DATABASE_URL });
  await reader.connect();
  await reader.query('SET default_transaction_read_only = on');

  const { rows: pending } = await reader.query(PENDING_CHECKS_SQL);
  if (pending.length === 0) {
    process.stdout.write('Aucune contrainte CHECK en attente de validation.\n');
    await reader.end();
    return;
  }

  const results = [];
  for (const c of pending) {
    const expression = extractCheckExpression(c.definition);
    // Nom de table et expression viennent du catalogue PostgreSQL, pas d'une
    // saisie : les interpoler est sûr (`regclass::text` rend un identifiant
    // déjà quoté si nécessaire).
    const { rows } = await reader.query(
      `SELECT count(*)::int AS n FROM ${c.table} WHERE (${expression}) IS FALSE`,
    );
    results.push({ ...c, violations: rows[0].n });
  }
  await reader.end();

  for (const r of results) {
    const state = r.violations === 0 ? '✅ 0 violation' : `❌ ${r.violations} ligne(s) en défaut`;
    process.stdout.write(`${state.padEnd(26)} ${r.table}.${r.name}\n`);
  }

  const clean = results.filter((r) => r.violations === 0);
  const dirty = results.filter((r) => r.violations > 0);
  process.stdout.write(
    `\n${clean.length} validable(s), ${dirty.length} à corriger d'abord.\n`,
  );

  if (!APPLY) {
    if (clean.length) process.stdout.write('Relancer avec --apply pour valider les contraintes propres.\n');
    return;
  }

  const writer = new Client({ connectionString: process.env.DATABASE_URL });
  await writer.connect();
  // Ne jamais faire la queue derrière une transaction longue : mieux vaut
  // échouer vite et relancer que bloquer les écritures derrière soi.
  await writer.query("SET lock_timeout = '5s'");
  let failures = 0;
  for (const r of clean) {
    try {
      await writer.query(`ALTER TABLE ${r.table} VALIDATE CONSTRAINT "${r.name}"`);
      process.stdout.write(`   validée : ${r.table}.${r.name}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`   ÉCHEC   : ${r.table}.${r.name} — ${error.message}\n`);
    }
  }
  await writer.end();
  if (failures || dirty.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
}

module.exports = { extractCheckExpression };
