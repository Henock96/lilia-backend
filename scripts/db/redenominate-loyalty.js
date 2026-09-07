// Redénomination du point de fidélité — 5 XAF → 50 XAF.
//
// ═══════════════════════════════════════════════════════════════════════════
// `--dry-run` EST LE DÉFAUT. Rien n'est écrit sans `--commit`.
// ═══════════════════════════════════════════════════════════════════════════
//
// ## Le problème qu'il résout
//
// `PlatformSettings.loyaltyPointValueXaf` est lu **au moment de la dépense**,
// jamais figé à l'acquisition. Le faire passer de 5 à 50 multiplierait donc par
// dix la valeur de **tout point déjà distribué** — un passif créé d'un coup,
// sans qu'aucune commande n'ait été passée. Les soldes existants viennent en
// outre d'un régime proportionnel (1 pt / 100 XAF dépensés) et d'anciens bonus
// de parrainage à 500 points : ils sont volumineux.
//
// On divise donc les soldes par dix **dans la même transaction** que le
// changement de barème. Les deux gestes sont indissociables : les séparer
// laisserait, pendant l'intervalle, tous les soldes valorisés au décuple.
//
// ## Les quatre propriétés exigées
//
//  · ATOMIQUE     — une seule transaction : soldes et barème basculent ensemble.
//  · IDEMPOTENT   — un compte déjà converti porte une écriture marquée ; il est
//                   ignoré. Rejouer le script ne divise pas une seconde fois.
//  · AUDITABLE    — chaque compte reçoit une écriture de ledger `ADJUSTMENT`
//                   portant le delta. Aucun `UPDATE` muet.
//  · NON DESTRUCTIF — aucune ligne historique n'est supprimée ni réécrite.
//
// L'écriture de ledger n'est pas un confort : `LoyaltyReconciliationService`
// compare chaque nuit `SUM(LoyaltyTransaction.points)` à `User.loyaltyPoints`.
// Diviser les soldes sans écrire le mouvement mettrait **tous** les comptes en
// dérive dès le lendemain matin.
//
// ## Arrondi
//
// `nouveau = round(ancien / 10)`, au plus proche, .5 vers le haut.
// 10 → 1, 50 → 5, 100 → 10, 500 → 50, et 15 → 2.
//
// `floor` aurait été plus prudent budgétairement mais retirerait jusqu'à
// 45 XAF de valeur à un client sans le prévenir ; `round` peut en offrir
// jusqu'à 25. On préfère offrir : la relation client coûte plus cher que
// l'écart.
//
// ## Utilisation
//
//   node scripts/db/redenominate-loyalty.js              # simulation
//   node scripts/db/redenominate-loyalty.js --commit     # exécution réelle
//
// Procédure complète (maintenance, ordre des étapes) : `docs/LOYALTY.md`.

require('../load-env').loadEnv();
const { Client } = require('pg');
const { assertLocalDatabase, describeTarget } = require('./target-database');

/** Marqueur d'idempotence. Ne jamais le changer sans changer de version. */
const MIGRATION_TAG = 'loyalty-redenomination-v1';

/** Ancienne et nouvelle valeur du point, en XAF. */
const OLD_POINT_VALUE = 5;
const NEW_POINT_VALUE = 50;
const DIVISOR = NEW_POINT_VALUE / OLD_POINT_VALUE; // 10

const COMMIT = process.argv.includes('--commit');

/** cuid-like : les identifiants sont générés côté application d'habitude. */
function generateId(index) {
  return `redenom_${Date.now().toString(36)}_${index.toString(36)}`;
}

(async () => {
  // ⚠️ Le `.env` de ce dépôt porte le `DATABASE_URL` de PRODUCTION. Ce script
  // réécrit tous les soldes de fidélité : il ne doit jamais partir par
  // inadvertance sur la vraie base. Fail-closed — toute base non locale est
  // refusée, sauf `LILIA_ALLOW_PRODUCTION_WRITES` posé explicitement.
  //
  // La garde ne s'applique qu'en `--commit` : une simulation en lecture est
  // précisément ce qu'on veut pouvoir faire contre la production avant de
  // décider quoi que ce soit.
  const target = COMMIT
    ? assertLocalDatabase('redénomination des soldes de fidélité')
    : describeTarget();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('═══ Redénomination du point de fidélité ═══════════════════');
  console.log(`Base          : ${target.label}`);
  console.log(`Mode          : ${COMMIT ? '⚠️  COMMIT (écriture réelle)' : 'simulation (--dry-run)'}`);
  console.log(`Conversion    : ${OLD_POINT_VALUE} XAF → ${NEW_POINT_VALUE} XAF le point`);
  console.log(`Soldes        : nouveau = round(ancien / ${DIVISOR})\n`);

  try {
    await client.query('BEGIN');

    // ─── Photographie AVANT ────────────────────────────────────────────────
    const before = await client.query(`
      SELECT count(*) FILTER (WHERE "loyaltyPoints" > 0)::int AS comptes,
             COALESCE(sum("loyaltyPoints"), 0)::int           AS points
        FROM "User"
    `);
    const settingsBefore = await client.query(
      `SELECT "loyaltyPointValueXaf" FROM "PlatformSettings" WHERE id = 'singleton'`,
    );
    const currentValue = settingsBefore.rows[0]?.loyaltyPointValueXaf;

    console.log('─── Avant ─────────────────────────────────────────────────');
    console.log(`Comptes avec des points : ${before.rows[0].comptes}`);
    console.log(`Points en circulation   : ${before.rows[0].points}`);
    console.log(
      `Passif actuel           : ${before.rows[0].points * (currentValue ?? OLD_POINT_VALUE)} XAF`,
    );
    console.log(`Valeur du point en base : ${currentValue} XAF\n`);

    if (currentValue !== OLD_POINT_VALUE) {
      // Garde-fou : si la valeur n'est pas celle attendue, soit le script a
      // déjà tourné, soit quelqu'un a changé le barème à la main. Dans les deux
      // cas, diviser à nouveau détruirait de la valeur.
      console.log(
        `⛔ La valeur du point vaut ${currentValue} XAF, pas ${OLD_POINT_VALUE}.`,
      );
      console.log(
        '   Le script refuse de convertir : soit il a déjà été exécuté, soit',
      );
      console.log(
        '   le barème a été modifié à la main. Vérifier `AdminAuditLog`.',
      );
      await client.query('ROLLBACK');
      await client.end();
      process.exit(1);
    }

    // ─── Comptes à convertir ───────────────────────────────────────────────
    // On exclut ceux qui portent déjà l'écriture marquée : c'est l'idempotence.
    const targets = await client.query(
      `
      SELECT u.id, u."loyaltyPoints"
        FROM "User" u
       WHERE u."loyaltyPoints" <> 0
         AND NOT EXISTS (
               SELECT 1 FROM "LoyaltyTransaction" lt
                WHERE lt."userId" = u.id
                  AND lt.metadata->>'migration' = $1
             )
       ORDER BY u."loyaltyPoints" DESC
    `,
      [MIGRATION_TAG],
    );

    const alreadyDone = await client.query(
      `SELECT count(DISTINCT "userId")::int AS n FROM "LoyaltyTransaction" WHERE metadata->>'migration' = $1`,
      [MIGRATION_TAG],
    );

    console.log('─── Conversion ────────────────────────────────────────────');
    console.log(`Comptes à convertir     : ${targets.rows.length}`);
    console.log(`Comptes déjà convertis  : ${alreadyDone.rows[0].n} (ignorés)\n`);

    let totalOld = 0;
    let totalNew = 0;
    let index = 0;

    for (const row of targets.rows) {
      const oldPoints = row.loyaltyPoints;
      const newPoints = Math.round(oldPoints / DIVISOR);
      const delta = newPoints - oldPoints;
      totalOld += oldPoints;
      totalNew += newPoints;

      if (delta !== 0) {
        // L'écriture de ledger vient AVANT le solde : c'est elle qui porte le
        // marqueur d'idempotence, donc elle qui doit exister si l'on rejoue.
        await client.query(
          `INSERT INTO "LoyaltyTransaction" (id, "userId", points, type, reason, metadata, "createdAt")
           VALUES ($1, $2, $3, 'ADJUSTMENT', $4, $5, now())`,
          [
            generateId(index++),
            row.id,
            delta,
            `Redénomination du point : ${OLD_POINT_VALUE} → ${NEW_POINT_VALUE} XAF (${oldPoints} → ${newPoints} pts)`,
            JSON.stringify({
              migration: MIGRATION_TAG,
              oldPoints,
              newPoints,
              oldPointValueXaf: OLD_POINT_VALUE,
              newPointValueXaf: NEW_POINT_VALUE,
            }),
          ],
        );
      }

      await client.query(
        `UPDATE "User" SET "loyaltyPoints" = $1 WHERE id = $2`,
        [newPoints, row.id],
      );
    }

    // ─── Bascule du barème, dans LA MÊME transaction ───────────────────────
    await client.query(
      `UPDATE "PlatformSettings"
          SET "loyaltyPointValueXaf" = $1,
              "loyaltyMinRedemption" = 1,
              "loyaltyPointsPerOrder" = 1,
              "referrerBonusPoints" = 1
        WHERE id = 'singleton'`,
      [NEW_POINT_VALUE],
    );

    // ─── Vérification de l'invariant AVANT de valider ──────────────────────
    // Le ledger et le solde doivent concorder sur chaque compte touché. Si un
    // seul diverge, on annule tout : c'est précisément l'invariant que la
    // réconciliation quotidienne contrôle.
    const drifts = await client.query(`
      SELECT u.id, u."loyaltyPoints", COALESCE(sum(lt.points), 0)::int AS ledger
        FROM "User" u
        LEFT JOIN "LoyaltyTransaction" lt ON lt."userId" = u.id
       GROUP BY u.id, u."loyaltyPoints"
      HAVING u."loyaltyPoints" <> COALESCE(sum(lt.points), 0)
       LIMIT 20
    `);

    const after = await client.query(`
      SELECT count(*) FILTER (WHERE "loyaltyPoints" > 0)::int AS comptes,
             COALESCE(sum("loyaltyPoints"), 0)::int           AS points
        FROM "User"
    `);

    console.log('─── Après ─────────────────────────────────────────────────');
    console.log(`Points en circulation   : ${after.rows[0].points}`);
    console.log(
      `Passif                  : ${after.rows[0].points * NEW_POINT_VALUE} XAF`,
    );
    console.log(
      `Passif avant conversion : ${before.rows[0].points * OLD_POINT_VALUE} XAF`,
    );
    console.log(
      `Écart dû à l'arrondi    : ${after.rows[0].points * NEW_POINT_VALUE - before.rows[0].points * OLD_POINT_VALUE} XAF`,
    );
    console.log(`Total points ${totalOld} → ${totalNew}\n`);

    if (drifts.rows.length > 0) {
      console.log('⛔ Solde et ledger divergent après conversion :');
      for (const d of drifts.rows) {
        console.log(`   ${d.id} : solde ${d.loyaltyPoints}, ledger ${d.ledger}`);
      }
      console.log('   ANNULATION — aucune écriture conservée.');
      await client.query('ROLLBACK');
      await client.end();
      process.exit(1);
    }
    console.log('✅ Solde et ledger concordent sur tous les comptes.\n');

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('✅ COMMIT — la conversion est appliquée.');
      console.log(
        '   Étape suivante : désactiver `maintenanceMode` (docs/LOYALTY.md).',
      );
    } else {
      await client.query('ROLLBACK');
      console.log('↩️  ROLLBACK — simulation, la base est inchangée.');
      console.log('   Relancer avec `--commit` pour appliquer.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error('ERREUR :', e.message);
  process.exit(1);
});
