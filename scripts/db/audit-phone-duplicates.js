// LECTURE SEULE — recense les numéros de téléphone portés par plusieurs comptes.
//
// ## Pourquoi ce script existe
//
// `User.phone` n'est pas `@unique`, et la contrainte ne peut pas être posée à
// l'aveugle : sa création échouerait sur le premier doublon, en pleine
// migration, sur la base de production. Il faut donc savoir **avant** ce qu'on
// va rencontrer.
//
// C'est aussi la raison pour laquelle il ne supprime, ne fusionne et ne
// modifie rien. Deux comptes partageant un numéro ne sont pas nécessairement
// une fraude — un parent qui inscrit son enfant, un commerçant et son employé.
// Décider lequel garder est un arbitrage humain ; ce script prépare cet
// arbitrage, il ne le remplace pas.
//
// ## Utilisation
//
//   node scripts/db/audit-phone-duplicates.js
//
// La session est ouverte en lecture seule : toute écriture accidentelle est
// refusée par PostgreSQL lui-même, pas seulement par la discipline de l'auteur.

require('../load-env').loadEnv();
const { Client } = require('pg');
const { assertLocalDatabase, describeTarget } = require('./target-database');

/**
 * Normalisation identique à `apps/lilia-app/src/modules/users/phone.util.ts` —
 * exprimée en SQL pour rapprocher `06 12 34 56 78`, `+242 06 12345678` et
 * `242061234567`, qui sont le même numéro écrit trois fois.
 *
 * ⚠️ Toute évolution de `normalizePhone` doit être répercutée ici, sinon le
 * rapport et le signal anti-abus ne parleront plus du même monde.
 */
const NORMALIZE = `
  CASE
    WHEN regexp_replace(phone, '\\D', '', 'g') = '' THEN NULL
    ELSE (
      WITH d AS (
        SELECT regexp_replace(phone, '\\D', '', 'g') AS digits
      ),
      no_cc AS (
        SELECT CASE
          WHEN digits LIKE '00242%' THEN substring(digits from 6)
          WHEN digits LIKE '242%' AND length(digits) > 9 THEN substring(digits from 4)
          ELSE digits
        END AS digits FROM d
      )
      SELECT CASE
        WHEN digits LIKE '0%' AND length(digits) > 1 THEN substring(digits from 2)
        ELSE digits
      END FROM no_cc
    )
  END`;

(async () => {
  // Lecture seule assumée : ce script est fait pour être lancé contre la
  // production, c'est même son intérêt. `describeTarget` sert donc à nommer la
  // base dans le rapport, pas à en refuser l'accès — et la session PostgreSQL
  // est ouverte en lecture seule, ce qui rend toute écriture impossible même
  // par accident.
  const target = describeTarget();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');

  // 1. Chaînes vides restantes — elles interdisent structurellement l'unicité,
  //    `NULL` y échappant en PostgreSQL mais pas `''`. La migration
  //    `20260907120000` les a normalisées ; s'il en reste, une écriture les a
  //    réintroduites et il faut trouver laquelle avant d'aller plus loin.
  const empty = await client.query(
    `SELECT count(*)::int AS n FROM "User" WHERE phone = ''`,
  );

  // 2. Numéros portés par plus d'un compte.
  const dupes = await client.query(`
    WITH normalized AS (
      SELECT id, "statusUser", role, "createdAt", ${NORMALIZE} AS norm
        FROM "User"
       WHERE phone IS NOT NULL
    )
    SELECT norm,
           count(*)::int                              AS comptes,
           count(*) FILTER (WHERE "statusUser" = 'ACTIVE')::int AS actifs,
           array_agg(id ORDER BY "createdAt")         AS user_ids
      FROM normalized
     WHERE norm IS NOT NULL
     GROUP BY norm
    HAVING count(*) > 1
     ORDER BY count(*) DESC, norm
  `);

  // 3. Croisement avec le parrainage : un doublon qui a déjà servi à toucher
  //    une récompense est le seul cas qui demande une décision rapide.
  const suspicious = await client.query(`
    WITH normalized AS (
      SELECT id, ${NORMALIZE} AS norm FROM "User" WHERE phone IS NOT NULL
    ),
    dupes AS (
      SELECT norm FROM normalized WHERE norm IS NOT NULL
       GROUP BY norm HAVING count(*) > 1
    )
    SELECT count(*)::int AS n
      FROM "User" u
      JOIN normalized n ON n.id = u.id
      JOIN dupes d ON d.norm = n.norm
     WHERE u."referralRewarded" = true
  `);

  const total = await client.query(`SELECT count(*)::int AS n FROM "User"`);

  console.log('─── Doublons de téléphone ──────────────────────────────────');
  console.log(`Base                             : ${target.label}`);
  console.log(`Comptes au total                 : ${total.rows[0].n}`);
  console.log(`Téléphones vides ('' au lieu de NULL) : ${empty.rows[0].n}`);
  console.log(`Numéros portés par ≥ 2 comptes   : ${dupes.rows.length}`);
  console.log(
    `Comptes en doublon ayant déjà généré une récompense : ${suspicious.rows[0].n}`,
  );
  console.log('');

  if (dupes.rows.length === 0) {
    console.log('✅ Aucun doublon. La contrainte `@@unique` peut être posée :');
    console.log(
      "   CREATE UNIQUE INDEX \"User_phone_key\" ON \"User\"(phone) WHERE phone IS NOT NULL;",
    );
  } else {
    console.log(
      '⚠️  La contrainte d’unicité échouerait. Aucun compte n’a été touché.',
    );
    console.log('   Chaque ligne demande un arbitrage humain :\n');
    for (const row of dupes.rows.slice(0, 50)) {
      // Le numéro est tronqué : ce rapport peut finir dans un ticket.
      const masked = `${row.norm.slice(0, 2)}${'•'.repeat(Math.max(0, row.norm.length - 4))}${row.norm.slice(-2)}`;
      console.log(
        `   ${masked}  ${row.comptes} comptes (${row.actifs} actifs)  →  ${row.user_ids.join(', ')}`,
      );
    }
    if (dupes.rows.length > 50) {
      console.log(`   … et ${dupes.rows.length - 50} autre(s).`);
    }
  }

  await client.end();
})().catch((e) => {
  console.error('ERREUR :', e.message);
  process.exit(1);
});
