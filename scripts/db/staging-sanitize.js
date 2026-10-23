// Anonymise une copie de la production pour en faire la préproduction.
//
// La préproduction est une branche Neon créée depuis la prod : elle en porte
// les vraies données. Deux dangers, que ce script ferme avant le premier
// démarrage du service (et après chaque rafraîchissement de la branche) :
//
// 1. Effets sortants. Les jetons FCM copiés enverraient les notifications de
//    test sur les téléphones de vrais clients ; les événements outbox en attente
//    seraient rejoués ; le versement automatique suivrait le réglage de prod.
// 2. Données personnelles. Téléphones (dont ceux de versement), e-mails, noms,
//    adresses, positions GPS.
//
// ## Ce qu'il fait
//
// - supprime `FcmToken`, `DeviceInstallation`, les `OutboxEvent` en attente et
//   les traces `DeliveryLocation` ;
// - coupe `PlatformSettings.vendorPayoutAutoEnabled` ;
// - remplace e-mails, téléphones, noms, adresses, coordonnées et notes par des
//   valeurs neutres, et vide les textes libres et JSON où des personnes ont
//   écrit (journal d'audit, incidents et leurs pièces jointes, motifs de
//   remboursement, avis livreur, rapports d'échec). `Review.comment` est
//   gardé : ces avis sont déjà publics en production. Les montants, statuts et identifiants ne bougent pas, et
//   `firebaseUid` est conservé : les vrais comptes se connectent toujours.
//
// Épargnés : les comptes ADMIN, et ceux passés par `--keep=` (tes comptes de
// test), avec leurs adresses, commandes, paiements et restaurants.
//
// ## Garde
//
// Deux cibles seulement, sans échappatoire :
// - une base locale ;
// - une base dont l'hôte figure dans `LILIA_STAGING_DATABASE_HOSTS` **et** qui
//   porte la marque `COMMENT ON DATABASE <base> IS 'lilia-staging'`.
// La marque vit dans la base : une branche fraîchement créée depuis la prod ne
// l'a pas, et la prod ne l'aura jamais. Se tromper d'hôte ne suffit donc pas.
//
// ## Usage
//
//   node scripts/db/staging-sanitize.js --keep=moi@exemple.com          (simulation)
//   node scripts/db/staging-sanitize.js --keep=moi@exemple.com --commit
//
// La simulation exécute tout dans une transaction puis l'annule : les comptes
// affichés sont exacts. Une seule transaction aussi en `--commit` : tout ou rien.
// Rejouable.

const { Client } = require('pg');
const { describeTarget } = require('./target-database');

const STAGING_MARKER = 'lilia-staging';
const MSISDN_PLACEHOLDER = '242060000000';
const LOCAL_PHONE_PLACEHOLDER = '060000000';
const MASKED_ADDRESS = 'Adresse masquée (préproduction)';
const MASKED_TEXT = '[contenu masqué — préproduction]';

/**
 * La cible est-elle anonymisable ?
 *
 * @param {{ ok: boolean, isLocal: boolean, isStaging: boolean }} target
 * @param {string | null} marker — commentaire de la base courante.
 */
function checkTarget(target, marker) {
  if (!target.ok)
    return { ok: false, reason: 'DATABASE_URL absent ou illisible.' };
  if (target.isLocal) return { ok: true, reason: 'base locale' };
  if (!target.isStaging) {
    return {
      ok: false,
      reason:
        'base distante non déclarée : elle est traitée comme la PRODUCTION. ' +
        "Déclarer l'hôte de la branche dans LILIA_STAGING_DATABASE_HOSTS.",
    };
  }
  if (marker !== STAGING_MARKER) {
    return {
      ok: false,
      reason:
        "hôte déclaré préproduction, mais la base n'en porte pas la marque. " +
        `Après vérification dans la console Neon : COMMENT ON DATABASE <base> IS '${STAGING_MARKER}';`,
    };
  }
  return { ok: true, reason: 'préproduction marquée' };
}

async function readMarker(client) {
  const { rows } = await client.query(
    `SELECT shobj_description(oid, 'pg_database') AS marker
       FROM pg_database WHERE datname = current_database()`,
  );
  return rows[0]?.marker ?? null;
}

/**
 * Requêtes, dans l'ordre. `keep_users` (table temporaire) liste les comptes
 * épargnés ; `keep_orders` leurs commandes.
 */
const STEPS = [
  ['FcmToken supprimés', `DELETE FROM "FcmToken"`],
  ['DeviceInstallation supprimées', `DELETE FROM "DeviceInstallation"`],
  [
    'OutboxEvent en attente supprimés',
    `DELETE FROM "OutboxEvent" WHERE status = 'PENDING'`,
  ],
  ['Positions GPS supprimées', `DELETE FROM "DeliveryLocation"`],
  [
    'Versement automatique coupé',
    `UPDATE "PlatformSettings" SET "vendorPayoutAutoEnabled" = false
      WHERE "vendorPayoutAutoEnabled" = true`,
  ],
  [
    'Utilisateurs anonymisés',
    `UPDATE "User" SET email = 'user-' || id || '@staging.invalid',
            phone = NULL, nom = 'Utilisateur ' || left(id, 6), "imageUrl" = NULL
      WHERE id NOT IN (SELECT id FROM keep_users)
        AND email <> 'user-' || id || '@staging.invalid'`,
  ],
  [
    'Adresses masquées',
    `UPDATE "Adresses" SET rue = $1, landmark = NULL, label = NULL,
            latitude = NULL, longitude = NULL
      WHERE "userId" NOT IN (SELECT id FROM keep_users) AND rue <> $1`,
    [MASKED_ADDRESS],
  ],
  [
    'Commandes anonymisées',
    `UPDATE "Order" SET
            "deliveryAddress" = CASE WHEN "deliveryAddress" IS NULL THEN NULL ELSE $1 END,
            "deliveryLandmark" = NULL, "deliveryLatitude" = NULL, "deliveryLongitude" = NULL,
            "contactPhone" = CASE WHEN "contactPhone" IS NULL THEN NULL ELSE $2 END,
            notes = NULL
      WHERE id NOT IN (SELECT id FROM keep_orders)`,
    [MASKED_ADDRESS, LOCAL_PHONE_PLACEHOLDER],
  ],
  [
    'Paiements anonymisés',
    `UPDATE payments SET "phoneNumber" = $1
      WHERE "orderId" NOT IN (SELECT id FROM keep_orders) AND "phoneNumber" <> $1`,
    [MSISDN_PLACEHOLDER],
  ],
  [
    'Versements anonymisés',
    `UPDATE restaurant_payouts SET "phoneNumber" = $1
      WHERE "orderId" NOT IN (SELECT id FROM keep_orders) AND "phoneNumber" <> $1`,
    [MSISDN_PLACEHOLDER],
  ],
  [
    'Remboursements anonymisés',
    `UPDATE "Refund" SET "phoneNumber" = $1
      WHERE "phoneNumber" IS NOT NULL AND "phoneNumber" <> $1
        AND "orderId" NOT IN (SELECT id FROM keep_orders)`,
    [MSISDN_PLACEHOLDER],
  ],
  [
    'Restaurants anonymisés',
    `UPDATE "Restaurant" SET phone = $2,
            email = CASE WHEN email IS NULL THEN NULL ELSE 'vendor-' || id || '@staging.invalid' END,
            "payoutPhoneNumber" = CASE WHEN "payoutPhoneNumber" IS NULL THEN NULL ELSE $1 END
      WHERE "ownerId" NOT IN (SELECT id FROM keep_users)
        AND (phone <> $2 OR "payoutPhoneNumber" <> $1
             OR email <> 'vendor-' || id || '@staging.invalid')`,
    [MSISDN_PLACEHOLDER, LOCAL_PHONE_PLACEHOLDER],
  ],
  [
    'Livraisons sans position',
    `UPDATE "Delivery" SET "lastLatitude" = NULL, "lastLongitude" = NULL
      WHERE "lastLatitude" IS NOT NULL OR "lastLongitude" IS NOT NULL`,
  ],
  [
    "Rapports d'échec sans position",
    `UPDATE "DeliveryFailureReport" SET latitude = NULL, longitude = NULL
      WHERE latitude IS NOT NULL OR longitude IS NOT NULL`,
  ],
  [
    'Profils livreur anonymisés',
    `UPDATE "DriverProfile"
        SET "plateNumber" = NULL, "licenseNumber" = NULL, "licenseExpiry" = NULL
      WHERE ("plateNumber" IS NOT NULL OR "licenseNumber" IS NOT NULL
             OR "licenseExpiry" IS NOT NULL)
        AND "userId" NOT IN (SELECT id FROM keep_users)`,
  ],
  // Textes libres et JSON. Écrits par de vrais clients, vendeurs ou admins, ils
  // portent des numéros (dont l'avant/après des comptes de versement dans le
  // journal d'audit) et des pièces jointes de réclamation. On garde la trace —
  // action, cible, date, montant — et on efface le contenu.
  [
    "Journal d'audit sans contenu",
    `UPDATE "AdminAuditLog"
        SET metadata = NULL,
            reason = CASE WHEN reason IS NULL THEN NULL ELSE $1 END
      WHERE metadata IS NOT NULL OR (reason IS NOT NULL AND reason <> $1)`,
    [MASKED_TEXT],
  ],
  [
    'Incidents sans contenu',
    `UPDATE "Incident"
        SET description = $1, metadata = NULL,
            resolution = CASE WHEN resolution IS NULL THEN NULL ELSE $1 END
      WHERE description <> $1 OR metadata IS NOT NULL
         OR (resolution IS NOT NULL AND resolution <> $1)`,
    [MASKED_TEXT],
  ],
  [
    "Messages d'incident sans contenu",
    `UPDATE "IncidentMessage" SET body = $1, attachments = '[]'::jsonb
      WHERE body <> $1 OR attachments <> '[]'::jsonb`,
    [MASKED_TEXT],
  ],
  [
    'Remboursements sans motif libre',
    `UPDATE "Refund" SET reason = $1, notes = NULL
      WHERE reason <> $1 OR notes IS NOT NULL`,
    [MASKED_TEXT],
  ],
  [
    'Avis livreur sans texte',
    `UPDATE "DeliveryReview" SET comment = NULL WHERE comment IS NOT NULL`,
  ],
  [
    "Rapports d'échec sans texte",
    `UPDATE "DeliveryFailureReport" SET note = NULL WHERE note IS NOT NULL`,
  ],
  [
    'Profils vendeur anonymisés',
    `UPDATE "VendorProfile" SET "licenseNumber" = NULL
      WHERE "licenseNumber" IS NOT NULL`,
  ],
];

/**
 * Exécute l'anonymisation dans une transaction, validée ou annulée.
 *
 * @param {import('pg').Client} client — connecté.
 * @param {{ keepEmails: string[], commit: boolean }} opts
 * @returns {Promise<Array<[string, number]>>} lignes touchées par étape.
 */
async function run(client, { keepEmails, commit }) {
  const counts = [];
  await client.query('BEGIN');
  try {
    await client.query(
      `CREATE TEMP TABLE keep_users ON COMMIT DROP AS
         SELECT id FROM "User" WHERE role = 'ADMIN' OR lower(email) = ANY($1)`,
      [keepEmails.map((e) => e.toLowerCase())],
    );
    await client.query(
      `CREATE TEMP TABLE keep_orders ON COMMIT DROP AS
         SELECT id FROM "Order" WHERE "userId" IN (SELECT id FROM keep_users)`,
    );
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM keep_users`,
    );
    counts.push(['Comptes épargnés (ADMIN + --keep)', rows[0].n]);

    for (const [label, sql, params] of STEPS) {
      const res = await client.query(sql, params ?? []);
      counts.push([label, res.rowCount ?? 0]);
    }
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return counts;
}

async function main() {
  require('../load-env').loadEnv();
  const commit = process.argv.includes('--commit');
  const keepEmails = (process.argv.find((a) => a.startsWith('--keep=')) ?? '')
    .replace('--keep=', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const target = describeTarget();
  console.log(`\nBase ciblée : ${target.label}\n`);
  if (!target.ok) {
    console.error(`🛑 REFUS — ${checkTarget(target, null).reason}\n`);
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const verdict = checkTarget(target, await readMarker(client));
    if (!verdict.ok) {
      console.error(`🛑 REFUS — ${verdict.reason}\n`);
      process.exitCode = 1;
      return;
    }

    const counts = await run(client, { keepEmails, commit });
    for (const [label, n] of counts) console.log(`  ${label.padEnd(36)} ${n}`);
    console.log(
      commit
        ? '\n✅ Anonymisation validée.\n'
        : '\nSimulation : transaction annulée, rien n’a été écrit. Ajouter --commit.\n',
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { checkTarget, readMarker, run, STAGING_MARKER };
