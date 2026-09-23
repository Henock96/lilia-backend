// LECTURE SEULE — état de référence avant la Phase 3 (L0-5, blueprint Phase 3).
//
// ## Pourquoi ce script existe
//
// Le Master Audit du 23/09/2026 marque trois fois « NON VÉRIFIÉ » des valeurs
// dont la Phase 3 dépend directement : le frais de service réellement appliqué,
// l'écriture des frais pawaPay (sans eux, le solde vendeur de F3-07 et le seuil
// des 4 yeux D7 se calculent sur du vide), et le mode de paiement effectif.
// Il sert aussi de point zéro pour les indicateurs de la vague 1 : sans mesure
// « avant », aucune fiche ne pourra prouver qu'elle a changé quelque chose.
//
// Une section par question, chacune reliée à la fiche qui en a besoin.
// `PAYMENT_MODE` est une variable d'environnement Render, pas une donnée : le
// script le **déduit** des fournisseurs des paiements récents, et le dit.
//
// ## Usage
//
//   npm run db:target                          # quelle base ?
//   node scripts/db/phase3-baseline.js         # rapport texte
//   node scripts/db/phase3-baseline.js --json  # pour archiver le point zéro
//
// La session est ouverte en `default_transaction_read_only = on` : aucune
// écriture n'est possible, même par accident, même sur la production.
const { loadEnv } = require('../load-env');
const { Client } = require('pg');
const { describeTarget } = require('./target-database');

const JSON_OUTPUT = process.argv.includes('--json');

/** Chaque requête répond à une question précise ; `why` dit qui l'attend. */
const CHECKS = [
  {
    key: 'platformSettings',
    why: 'L0-5 — valeurs réellement appliquées (défaut schéma : service 8 %, point 50 XAF)',
    sql: `SELECT "serviceFeePercent", "restaurantCommissionPercent",
                 "driverSharePercentLilia", "driverSharePercentIndependent",
                 "loyaltyPointValueXaf", "loyaltyPointsPerOrder",
                 "maintenanceMode", "minAppVersion", "updatedAt"
            FROM "PlatformSettings"`,
  },
  {
    key: 'paymentProviders30d',
    why: 'PAYMENT_MODE effectif, déduit des paiements des 30 derniers jours',
    sql: `SELECT provider, status, count(*)::int AS n
            FROM payments
           WHERE "createdAt" >= now() - interval '30 days'
           GROUP BY 1, 2 ORDER BY 1, 2`,
  },
  {
    key: 'collectionFees',
    why: 'F3-07 / D6 / D7 — frais d’encaissement pawaPay écrits ? (0/61 au 16/09)',
    sql: `SELECT provider,
                 count(*)::int                                   AS succes,
                 count("collectionFeeXaf")::int                  AS frais_renseignes,
                 coalesce(sum("collectionFeeXaf"), 0)::int       AS frais_total_xaf
            FROM payments
           WHERE status = 'SUCCESS'
           GROUP BY 1 ORDER BY 1`,
  },
  {
    key: 'payoutFees',
    why: 'F3-07 / D6 — frais de reversement écrits ? (0/2 au 16/09)',
    sql: `SELECT status,
                 count(*)::int                                   AS n,
                 count("payoutFeeXaf")::int                      AS frais_renseignes,
                 coalesce(sum(amount), 0)::int                   AS montant_xaf
            FROM restaurant_payouts
           GROUP BY 1 ORDER BY 1`,
  },
  {
    key: 'handoverSinceDeploy',
    why: 'L0-4 — les courses livrées depuis la Phase 2 sont-elles conclues par code ?',
    sql: `SELECT coalesce("handoverMethod"::text, 'NULL (antérieure)') AS methode,
                 count(*)::int AS n
            FROM "Delivery"
           WHERE status = 'LIVRER' AND "deliveredAt" >= now() - interval '7 days'
           GROUP BY 1 ORDER BY 2 DESC`,
  },
  {
    key: 'adminPushReach',
    why: 'L0-9 — les alertes admin du cockpit (F3-04) toucheraient-elles quelqu’un ?',
    sql: `SELECT u.id, u.email, count(t.id)::int AS jetons_fcm
            FROM "User" u
            LEFT JOIN "FcmToken" t ON t."userId" = u.id
           WHERE u.role = 'ADMIN' AND u."statusUser" = 'ACTIVE'
           GROUP BY 1, 2 ORDER BY 3, 2`,
  },
  {
    key: 'stuckPaidOrders',
    why: 'F3-01 — point zéro : commandes PAYER sans réponse vendeur, par ancienneté',
    sql: `SELECT CASE
                   WHEN now() - "paidAt" < interval '10 minutes' THEN '< 10 min'
                   WHEN now() - "paidAt" < interval '1 hour'     THEN '10 min – 1 h'
                   WHEN now() - "paidAt" < interval '1 day'      THEN '1 h – 24 h'
                   ELSE '> 24 h'
                 END AS anciennete,
                 count(*)::int AS n
            FROM "Order"
           WHERE status = 'PAYER'
           GROUP BY 1 ORDER BY 1`,
  },
  {
    key: 'vendorResponseTime90d',
    why: 'F3-01 / D1 — délai réel paiement → première action vendeur (90 j)',
    sql: `WITH first_move AS (
            SELECT o.id, o."paidAt",
                   min(h."createdAt") FILTER (WHERE h."fromStatus" = 'PAYER') AS moved_at
              FROM "Order" o
              JOIN "OrderHistory" h ON h."orderId" = o.id
             WHERE o."paidAt" >= now() - interval '90 days'
             GROUP BY o.id, o."paidAt"
          )
          SELECT count(*)::int                                                     AS commandes_payees,
                 count(moved_at)::int                                              AS avec_reponse,
                 round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP
                   (ORDER BY moved_at - "paidAt")) / 60)::int                     AS mediane_min,
                 round(extract(epoch FROM percentile_cont(0.9) WITHIN GROUP
                   (ORDER BY moved_at - "paidAt")) / 60)::int                     AS p90_min,
                 count(*) FILTER (WHERE moved_at - "paidAt" > interval '8 minutes')::int AS au_dela_8_min
            FROM first_move`,
  },
  {
    key: 'vendorDeliveryPricing',
    why: 'F3-02 / F-05 — qui fixe quoi : mode de prix et frais fixes des vendeurs publiés',
    sql: `SELECT "deliveryPriceMode" AS mode,
                 count(*)::int AS vendeurs,
                 count(*) FILTER (WHERE "deliveryPriceMode" = 'FIXED' AND "fixedDeliveryFee" = 0)::int
                   AS frais_fixes_a_zero,
                 min("fixedDeliveryFee")::int AS min_fixe,
                 max("fixedDeliveryFee")::int AS max_fixe
            FROM "Restaurant"
           WHERE "onboardingStatus" = 'ACTIVATED' AND "adminApproved" AND "isActive"
           GROUP BY 1 ORDER BY 1`,
  },
  {
    key: 'zeroPayIndependentDeliveries',
    why: 'F3-02 — courses d’indépendants payées 0 XAF (critère de sortie S-2)',
    sql: `SELECT count(*)::int AS n
            FROM "Delivery"
           WHERE status = 'LIVRER'
             AND "driverEmploymentType" = 'INDEPENDENT'
             AND coalesce("driverPayXaf", 0) = 0`,
  },
  {
    key: 'pendingChecks',
    why: 'L0-6 — contraintes CHECK encore NOT VALID (voir validate-check-constraints.js)',
    sql: `SELECT conrelid::regclass::text AS "table", conname AS contrainte
            FROM pg_constraint
           WHERE contype = 'c' AND NOT convalidated
           ORDER BY 1, 2`,
  },
];

async function main() {
  loadEnv();
  const target = describeTarget();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');

  const report = { target: target.label, generatedAt: new Date().toISOString(), checks: {} };
  for (const check of CHECKS) {
    try {
      const { rows } = await client.query(check.sql);
      report.checks[check.key] = { why: check.why, rows };
    } catch (error) {
      // Une section qui échoue (colonne absente sur une base en retard de
      // migration) ne doit pas masquer les autres.
      report.checks[check.key] = { why: check.why, error: error.message };
    }
  }
  await client.end();

  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `\nBase ciblée : ${target.label}${target.isLocal ? '' : '  ⚠️  NON LOCALE (lecture seule)'}\n`,
  );
  for (const [key, section] of Object.entries(report.checks)) {
    process.stdout.write(`\n── ${key} — ${section.why}\n`);
    if (section.error) process.stdout.write(`   ERREUR : ${section.error}\n`);
    else if (section.rows.length === 0) process.stdout.write('   (aucune ligne)\n');
    else console.table(section.rows);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
