/**
 * Suppression PHYSIQUE d'un vendeur (Restaurant) et de tout ce qui en dépend.
 *
 * Réservé aux vendeurs de test. Pour un vendeur réel, la bonne opération est
 * `PATCH /admin/vendors/:id/suspend` : `Order` et `payments` sont des pièces
 * comptables, les effacer fausse rétroactivement le CA et les dashboards.
 *
 *   node scripts/db/delete-vendor.js --list                 # inventaire, lecture seule
 *   node scripts/db/delete-vendor.js <id> [<id>…]           # RÉPÉTITION À BLANC (ROLLBACK)
 *   node scripts/db/delete-vendor.js <id> --commit          # suppression réelle
 *   node scripts/db/delete-vendor.js <id> --commit --force  # outrepasse les garde-fous
 *   node scripts/db/delete-vendor.js <id> --commit --with-owner
 *
 * Sans `--commit`, tout est joué dans une transaction annulée : les décomptes
 * affichés sont ceux que PostgreSQL a réellement calculés, mais la base ressort
 * inchangée. C'est le même protocole que `dry-run-fk-migration.js`.
 */
require('dotenv').config();
const { Client } = require('pg');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');
const WITH_OWNER = args.includes('--with-owner');
const IDS = args.filter((a) => !a.startsWith('--'));

/**
 * Ordre imposé par les clés étrangères posées en août 2026
 * (`20260827120000_enable_foreign_keys`). Tout ce qui est en CASCADE est absent
 * de cette liste : PostgreSQL s'en charge — `Specialty`, `OperatingHours`,
 * `DeliveryZone` (→ `QuartierZone`), `Banner`, `VendorPhoto`, `OrderHistory`,
 * `DeliveryLocation`, `ProductVariant`, `ProductImage`, `MenuImage`,
 * `MenuProduct`.
 *
 * `$1` = tableau d'ids de vendeurs.
 */
const ORDERS = `SELECT id FROM "Order" WHERE "restaurantId" = ANY($1::text[])`;
const PRODUCTS = `SELECT id FROM "Product" WHERE "restaurantId" = ANY($1::text[])`;
const PROMOS = `SELECT id FROM "PromoCode" WHERE "restaurantId" = ANY($1::text[])`;

const STEPS = [
  // ─── Argent ───────────────────────────────────────────────────────────────
  // PaymentEvent est en SET NULL des deux côtés : sans suppression explicite il
  // resterait des lignes ne pointant plus vers rien.
  [
    'PaymentEvent',
    `DELETE FROM "PaymentEvent"
      WHERE "paymentId" IN (SELECT id FROM payments WHERE "orderId" IN (${ORDERS}))
         OR "payoutId"  IN (SELECT id FROM restaurant_payouts WHERE "restaurantId" = ANY($1::text[]))`,
  ],
  ['Refund', `DELETE FROM "Refund" WHERE "orderId" IN (${ORDERS})`],
  [
    'restaurant_payouts',
    `DELETE FROM restaurant_payouts WHERE "restaurantId" = ANY($1::text[])`,
  ],
  ['payments', `DELETE FROM payments WHERE "orderId" IN (${ORDERS})`],

  // ─── Livraisons ───────────────────────────────────────────────────────────
  [
    'DeliveryReview',
    `DELETE FROM "DeliveryReview"
      WHERE "deliveryId" IN (SELECT id FROM "Delivery" WHERE "orderId" IN (${ORDERS}))`,
  ],
  ['Delivery', `DELETE FROM "Delivery" WHERE "orderId" IN (${ORDERS})`],

  // ─── Lignes SANS clé étrangère : personne ne les supprimera à notre place ──
  // Ces quatre tables portent un `orderId` / `restaurantId` en simple `String`,
  // hors relation Prisma. Elles ne bloquent rien et deviendraient des orphelins
  // silencieux, invisibles pour `audit-orphans.js`.
  [
    'PromoUsage (commandes)',
    `DELETE FROM "PromoUsage" WHERE "orderId" IN (${ORDERS})`,
  ],
  [
    'PromoUsage (codes du vendeur)',
    `DELETE FROM "PromoUsage" WHERE "promoCodeId" IN (${PROMOS})`,
  ],
  [
    'LoyaltyTransaction',
    `DELETE FROM "LoyaltyTransaction" WHERE "orderId" IN (${ORDERS})`,
  ],
  [
    'OutboxEvent',
    `DELETE FROM "OutboxEvent"
      WHERE "aggregateId" IN (${ORDERS}) OR "aggregateId" = ANY($1::text[])`,
  ],
  [
    'Incident',
    `DELETE FROM "Incident"
      WHERE "restaurantId" = ANY($1::text[]) OR "orderId" IN (${ORDERS})`,
  ],

  // ─── Commandes ────────────────────────────────────────────────────────────
  ['Review', `DELETE FROM "Review" WHERE "restaurantId" = ANY($1::text[])`],
  ['OrderItem', `DELETE FROM "OrderItem" WHERE "orderId" IN (${ORDERS})`],
  ['Order', `DELETE FROM "Order" WHERE "restaurantId" = ANY($1::text[])`],

  // ─── Catalogue ────────────────────────────────────────────────────────────
  // Le panier d'un client tiers référence produit ET variante en RESTRICT ;
  // filtrer sur le produit couvre les deux, la variante lui appartenant.
  ['CartItem', `DELETE FROM "CartItem" WHERE "productId" IN (${PRODUCTS})`],
  ['Product', `DELETE FROM "Product" WHERE "restaurantId" = ANY($1::text[])`],
  [
    'MenuDuJour',
    `DELETE FROM "MenuDuJour" WHERE "restaurantId" = ANY($1::text[])`,
  ],

  // ─── Vendeur ──────────────────────────────────────────────────────────────
  ['Favorite', `DELETE FROM "Favorite" WHERE "restaurantId" = ANY($1::text[])`],
  [
    'VendorProfile',
    `DELETE FROM "VendorProfile" WHERE "restaurantId" = ANY($1::text[])`,
  ],
  // ⚠️ Sans ce DELETE, la contrainte est en SET NULL : un code promo réservé à
  // ce vendeur deviendrait valable sur TOUTE la plateforme.
  ['PromoCode', `DELETE FROM "PromoCode" WHERE "restaurantId" = ANY($1::text[])`],
  ['Restaurant', `DELETE FROM "Restaurant" WHERE id = ANY($1::text[])`],
];

/**
 * Volontairement conservé : `AdminAuditLog` est un journal opposable en écriture
 * seule. La trace des actions passées sur ce vendeur doit survivre à sa
 * suppression — c'est précisément ce à quoi elle sert.
 */

async function list(client) {
  const { rows } = await client.query(`
    SELECT r.id,
           r.nom,
           r."vendorType",
           r."isActive",
           r."onboardingStatus",
           to_char(r."createdAt", 'YYYY-MM-DD') AS cree_le,
           u.email AS proprietaire,
           (SELECT COUNT(*) FROM "Order" o WHERE o."restaurantId" = r.id) AS commandes,
           (SELECT COUNT(*) FROM "Order" o
             WHERE o."restaurantId" = r.id AND o."paidAt" IS NOT NULL) AS payees,
           (SELECT COUNT(*) FROM "Product" p WHERE p."restaurantId" = r.id) AS produits
      FROM "Restaurant" r
      JOIN "User" u ON u.id = r."ownerId"
     ORDER BY commandes ASC, r."createdAt" ASC
  `);
  console.table(rows);
  console.log(
    `\n${rows.length} vendeur(s). Candidats à la suppression : ceux à 0 commande payée.`,
  );
}

/** Refuse ce qui n'est manifestement pas un vendeur de test. */
async function guard(client, ids) {
  const { rows } = await client.query(
    `
    SELECT
      (SELECT COUNT(*) FROM "Order"
        WHERE "restaurantId" = ANY($1::text[])
          AND status NOT IN ('LIVRER','ANNULER'))::int AS en_cours,
      (SELECT COUNT(*) FROM payments p
        JOIN "Order" o ON o.id = p."orderId"
       WHERE o."restaurantId" = ANY($1::text[]) AND p.status = 'SUCCESS')::int AS encaissements,
      (SELECT COUNT(*) FROM restaurant_payouts
        WHERE "restaurantId" = ANY($1::text[]) AND status IN ('PENDING','SUCCESS'))::int AS reversements
  `,
    [ids],
  );
  const g = rows[0];
  const bloquants = [];
  if (g.en_cours) bloquants.push(`${g.en_cours} commande(s) non terminale(s)`);
  if (g.encaissements)
    bloquants.push(`${g.encaissements} paiement(s) SUCCESS (argent réellement encaissé)`);
  if (g.reversements)
    bloquants.push(`${g.reversements} reversement(s) vendeur PENDING/SUCCESS`);
  return bloquants;
}

/** Relève les `public_id` Cloudinary AVANT suppression : après, ils sont introuvables. */
async function cloudinary(client, ids) {
  const { rows } = await client.query(
    `
      SELECT 'Restaurant' AS source, "imagePublicId" AS public_id
        FROM "Restaurant" WHERE id = ANY($1::text[]) AND "imagePublicId" IS NOT NULL
    UNION ALL
      SELECT 'VendorPhoto', "publicId" FROM "VendorPhoto"
       WHERE "restaurantId" = ANY($1::text[]) AND "publicId" IS NOT NULL
    UNION ALL
      SELECT 'ProductImage', pi."publicId" FROM "ProductImage" pi
        JOIN "Product" p ON p.id = pi."productId"
       WHERE p."restaurantId" = ANY($1::text[]) AND pi."publicId" IS NOT NULL
    UNION ALL
      SELECT 'MenuImage', mi."publicId" FROM "MenuImage" mi
        JOIN "MenuDuJour" m ON m.id = mi."menuDuJourId"
       WHERE m."restaurantId" = ANY($1::text[]) AND mi."publicId" IS NOT NULL
  `,
    [ids],
  );
  return rows;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    if (LIST || IDS.length === 0) {
      await client.query('SET default_transaction_read_only = on');
      await list(client);
      if (!LIST) console.log('\nUsage : node scripts/db/delete-vendor.js <id> [--commit]');
      return;
    }

    const { rows: cibles } = await client.query(
      `SELECT r.id, r.nom, r."ownerId", u.email, u."firebaseUid"
         FROM "Restaurant" r JOIN "User" u ON u.id = r."ownerId"
        WHERE r.id = ANY($1::text[])`,
      [IDS],
    );
    const introuvables = IDS.filter((id) => !cibles.some((c) => c.id === id));
    if (introuvables.length) {
      console.error(`❌ Id(s) inconnu(s) : ${introuvables.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log(COMMIT ? '🔴 SUPPRESSION RÉELLE' : '🧪 RÉPÉTITION À BLANC (ROLLBACK final)');
    console.table(cibles.map(({ id, nom, email }) => ({ id, nom, proprietaire: email })));

    const bloquants = await guard(client, IDS);
    if (bloquants.length) {
      console.error('\n⛔ Garde-fous déclenchés :');
      bloquants.forEach((b) => console.error(`   · ${b}`));
      if (!FORCE) {
        console.error(
          "\nCe vendeur n'a pas l'air d'être un vendeur de test. Préférez\n" +
            'PATCH /admin/vendors/:id/suspend. Pour passer outre : --force.',
        );
        process.exitCode = 1;
        return;
      }
      console.error('   → --force : on continue quand même.\n');
    }

    const images = await cloudinary(client, IDS);

    await client.query('BEGIN');
    const recap = [];
    for (const [table, sql] of STEPS) {
      const { rowCount } = await client.query(sql, [IDS]);
      if (rowCount) recap.push({ table, lignes: rowCount });
    }

    let anonymises = [];
    if (WITH_OWNER) {
      const owners = cibles.map((c) => c.ownerId);
      for (const [table, sql] of [
        ['FcmToken', `DELETE FROM "FcmToken" WHERE "userId" = ANY($1::text[])`],
        [
          'CartItem (owner)',
          `DELETE FROM "CartItem" WHERE "cartId" IN (SELECT id FROM "Cart" WHERE "userId" = ANY($1::text[]))`,
        ],
        ['Cart', `DELETE FROM "Cart" WHERE "userId" = ANY($1::text[])`],
        ['Adresses', `DELETE FROM "Adresses" WHERE "userId" = ANY($1::text[])`],
        ['Favorite (owner)', `DELETE FROM "Favorite" WHERE "userId" = ANY($1::text[])`],
        ['Review (owner)', `DELETE FROM "Review" WHERE "userId" = ANY($1::text[])`],
        [
          'LoyaltyTransaction (owner)',
          `DELETE FROM "LoyaltyTransaction" WHERE "userId" = ANY($1::text[])`,
        ],
      ]) {
        const { rowCount } = await client.query(sql, [owners]);
        if (rowCount) recap.push({ table, lignes: rowCount });
      }

      // Le compte n'est pas toujours supprimable : `AdminAuditLog.actorId` est en
      // RESTRICT (journal opposable, volontairement conservé) et le propriétaire
      // peut aussi avoir commandé en tant que client. Plutôt que de faire échouer
      // toute la transaction, on retombe sur l'anonymisation — exactement ce que
      // fait `UserDeletionService` pour `DELETE /users/me`, et pour les mêmes
      // raisons.
      await client.query('SAVEPOINT owner_delete');
      try {
        const { rowCount } = await client.query(
          `DELETE FROM "User" WHERE id = ANY($1::text[])`,
          [owners],
        );
        if (rowCount) recap.push({ table: 'User (supprimé)', lignes: rowCount });
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT owner_delete');
        const { rows } = await client.query(
          `UPDATE "User" SET
              "firebaseUid" = 'deleted-' || id,
              email         = 'deleted-' || id || '@deleted.liliafood.com',
              nom = NULL, phone = NULL, "imageUrl" = NULL, "lastLogin" = NULL,
              "statusUser" = 'DELETED', "driverStatus" = NULL,
              "referralCode" = NULL, "referredByCode" = NULL, "loyaltyPoints" = 0,
              "welcomeEmailSentAt" = NULL, "welcomeSmsSentAt" = NULL,
              "updatedAt" = now()
            WHERE id = ANY($1::text[])
            RETURNING id`,
          [owners],
        );
        anonymises = rows.map((r) => r.id);
        recap.push({ table: 'User (anonymisé)', lignes: rows.length });
      }
    }

    console.table(recap);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('✅ COMMIT — suppression effective, irréversible.');
    } else {
      await client.query('ROLLBACK');
      console.log("↩️  ROLLBACK — la base n'a pas été modifiée. Ajoutez --commit.");
    }

    if (images.length) {
      console.log('\n🖼️  À supprimer dans Cloudinary (le script n\'y touche pas) :');
      console.table(images);
    }
    if (WITH_OWNER) {
      console.log('\n🔥 Comptes Firebase Auth à supprimer à la main :');
      console.table(cibles.map(({ email, firebaseUid }) => ({ email, firebaseUid })));
      if (anonymises.length) {
        console.log(
          `⚠️  ${anonymises.length} compte(s) non supprimable(s) (journal d'audit ou\n` +
            '   commandes passées en tant que client) : anonymisé(s) à la place.',
        );
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n❌ Échec — rien n'a été supprimé.`);
    console.error(`   ${err.message}`);
    if (err.detail) console.error(`   ${err.detail}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
