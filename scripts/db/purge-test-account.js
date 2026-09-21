// Suppression d'un compte de test AVEC tout ce qu'il a produit.
//
// ⚠️ CET OUTIL DÉTRUIT DES PIÈCES COMPTABLES. Il est distinct de
// `purge-traceless-users.js`, qui refuse par construction tout compte porteur
// d'une commande — et ce refus est la bonne règle dans le cas général.
//
// Il existe pour le cas que cette règle traite mal : un compte de test dont les
// commandes polluent les chiffres. Sur la production Lilia Food au 21/09/2026,
// un seul compte portait 83 des 123 commandes — 67 % de la base. Tant qu'il y
// reste, aucun tableau de bord ne dit la vérité, et « préserver les pièces
// comptables » revient à préserver du faux.
//
// ## Ce qu'il détruit
//
// Tout ce qui pend au compte : commandes et leurs articles, encaissements même
// réussis, reversements vendeur, remboursements, livraisons, positions GPS,
// journaux d'assignation, notes, usages de codes promo, écritures de fidélité,
// récompenses de parrainage, incidents, événements de paiement.
//
// ## Ce qu'il préserve, et c'est le point délicat
//
// Une livraison portée par le compte supprimé mais rattachée à la commande
// d'un AUTRE client n'est pas détruite : elle perd son livreur
// (`delivererId → NULL`) et garde son existence. Détruire la course d'un vrai
// client parce que son livreur était un compte de test serait exactement
// l'erreur que cet outil doit éviter.
//
// ## Filet
//
// Avant toute écriture, l'intégralité des lignes visées est exportée en JSON
// dans `backups/`. Ce n'est pas une sauvegarde de base — c'est de quoi
// reconstituer ce qui a été détruit, et de quoi répondre à « qu'est-ce qui est
// parti exactement ? » trois mois plus tard.
//
// La suppression est une transaction unique. Les contraintes `RESTRICT` du
// schéma servent de garde-fou : si une table a été oubliée dans l'ordre de
// suppression, PostgreSQL refuse, tout est annulé, et l'erreur nomme la table.
// On ne peut donc pas laisser d'orphelins en silence.
//
// ## Usage
//
//   node scripts/db/purge-test-account.js --emails=a@b.com,c@d.com
//   node scripts/db/purge-test-account.js --emails=… --apply --i-understand-this-destroys-accounting
//
// ⚠️ Vérifier la base ciblée AVANT : `npm run db:target`.

require('../load-env').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { describeTarget } = require('./target-database');

const APPLY = process.argv.includes('--apply');
const AVOWED = process.argv.includes('--i-understand-this-destroys-accounting');
const EMAILS = (process.argv.find((a) => a.startsWith('--emails=')) ?? '')
  .replace('--emails=', '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Ce qu'on compte avant d'agir, et qu'on réaffiche après. */
const INVENTAIRE = [
  ['Commandes', `SELECT COUNT(*)::int n FROM "Order" o WHERE o."userId" = ANY($1)`],
  ['  dont encaissées', `SELECT COUNT(*)::int n FROM "Order" o JOIN payments p ON p."orderId"=o.id AND p.status='SUCCESS' WHERE o."userId" = ANY($1)`],
  ['  CA enregistré (XAF)', `SELECT COALESCE(SUM(o.total),0)::int n FROM "Order" o JOIN payments p ON p."orderId"=o.id AND p.status='SUCCESS' WHERE o."userId" = ANY($1)`],
  ['Articles de commande', `SELECT COUNT(*)::int n FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" WHERE o."userId" = ANY($1)`],
  ['Encaissements', `SELECT COUNT(*)::int n FROM payments p JOIN "Order" o ON o.id=p."orderId" WHERE o."userId" = ANY($1)`],
  ['Reversements vendeur', `SELECT COUNT(*)::int n FROM restaurant_payouts r JOIN "Order" o ON o.id=r."orderId" WHERE o."userId" = ANY($1)`],
  ['  dont SUCCESS', `SELECT COUNT(*)::int n FROM restaurant_payouts r JOIN "Order" o ON o.id=r."orderId" WHERE o."userId" = ANY($1) AND r.status='SUCCESS'`],
  ['Livraisons de ses commandes', `SELECT COUNT(*)::int n FROM "Delivery" d JOIN "Order" o ON o.id=d."orderId" WHERE o."userId" = ANY($1)`],
  ['Courses chez AUTRUI (préservées)', `SELECT COUNT(*)::int n FROM "Delivery" d JOIN "Order" o ON o.id=d."orderId" WHERE d."delivererId" = ANY($1) AND NOT (o."userId" = ANY($1))`],
];

/**
 * Ordre de suppression : des feuilles vers la racine.
 *
 * `$1` = identifiants des comptes visés. Chaque requête est indépendante et
 * idempotente ; l'ordre n'est contraint que par les clés étrangères.
 */
const ETAPES = [
  // — Événements de paiement : ils référencent encaissements ET reversements.
  ['PaymentEvent', `DELETE FROM "PaymentEvent" e WHERE e."paymentId" IN (SELECT p.id FROM payments p JOIN "Order" o ON o.id=p."orderId" WHERE o."userId" = ANY($1)) OR e."payoutId" IN (SELECT r.id FROM restaurant_payouts r JOIN "Order" o ON o.id=r."orderId" WHERE o."userId" = ANY($1))`],
  ['Refund', `DELETE FROM "Refund" x WHERE x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  ['restaurant_payouts', `DELETE FROM restaurant_payouts x WHERE x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  ['payments', `DELETE FROM payments x WHERE x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],

  // — Courses. D'abord celles d'AUTRUI : on ne détruit pas, on détache.
  ['DeliveryReview (autrui)', `DELETE FROM "DeliveryReview" x WHERE x."delivererId" = ANY($1) OR x."userId" = ANY($1)`],
  ['DeliveryAssignment', `DELETE FROM "DeliveryAssignment" x WHERE x."delivererId" = ANY($1) OR x."deliveryId" IN (SELECT d.id FROM "Delivery" d JOIN "Order" o ON o.id=d."orderId" WHERE o."userId" = ANY($1))`],
  ['DeliveryLocation', `DELETE FROM "DeliveryLocation" x WHERE x."deliveryId" IN (SELECT d.id FROM "Delivery" d JOIN "Order" o ON o.id=d."orderId" WHERE o."userId" = ANY($1))`],
  ['Delivery (ses commandes)', `DELETE FROM "Delivery" x WHERE x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  // ⚠️ DÉTACHEMENT, pas suppression : ces courses appartiennent aux commandes
  // de vrais clients. Elles perdent leur livreur, elles gardent leur existence.
  ['Delivery (autrui → détachée)', `UPDATE "Delivery" SET "delivererId" = NULL WHERE "delivererId" = ANY($1)`],
  ['driver_settlements', `DELETE FROM driver_settlements x WHERE x."driverId" = ANY($1)`],

  // — Effets métier rattachés aux commandes ou au compte.
  ['PromoUsage', `DELETE FROM "PromoUsage" x WHERE x."userId" = ANY($1) OR x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  ['LoyaltyTransaction', `DELETE FROM "LoyaltyTransaction" x WHERE x."userId" = ANY($1) OR x."actorId" = ANY($1) OR x."sourceUserId" = ANY($1) OR x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  ['ReferralReward', `DELETE FROM "ReferralReward" x WHERE x."referrerId" = ANY($1) OR x."referredUserId" = ANY($1) OR x."reviewedById" = ANY($1) OR x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  ['Review', `DELETE FROM "Review" x WHERE x."userId" = ANY($1) OR x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  ['Incident', `DELETE FROM "Incident" x WHERE x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  ['OutboxEvent', `DELETE FROM "OutboxEvent" x WHERE x."aggregateId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],

  // — Les commandes elles-mêmes. `OrderHistory` part en cascade.
  ['OrderItem', `DELETE FROM "OrderItem" x WHERE x."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1))`],
  ['Order', `DELETE FROM "Order" x WHERE x."userId" = ANY($1)`],

  // — Le compte et ses satellites personnels.
  ['CartItem', `DELETE FROM "CartItem" x WHERE x."cartId" IN (SELECT id FROM "Cart" WHERE "userId" = ANY($1))`],
  ['Cart', `DELETE FROM "Cart" x WHERE x."userId" = ANY($1)`],
  ['Adresses', `DELETE FROM "Adresses" x WHERE x."userId" = ANY($1)`],
  ['Favorite', `DELETE FROM "Favorite" x WHERE x."userId" = ANY($1)`],
  ['FcmToken', `DELETE FROM "FcmToken" x WHERE x."userId" = ANY($1)`],
  ['AdminAuditLog', `DELETE FROM "AdminAuditLog" x WHERE x."actorId" = ANY($1)`],
  ['User', `DELETE FROM "User" x WHERE x.id = ANY($1)`],
];

/** Tables exportées avant destruction, pour pouvoir dire ce qui est parti. */
const EXPORT = [
  ['users', `SELECT * FROM "User" WHERE id = ANY($1)`],
  ['orders', `SELECT * FROM "Order" WHERE "userId" = ANY($1)`],
  ['order_items', `SELECT i.* FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" WHERE o."userId" = ANY($1)`],
  ['payments', `SELECT p.* FROM payments p JOIN "Order" o ON o.id=p."orderId" WHERE o."userId" = ANY($1)`],
  ['payouts', `SELECT r.* FROM restaurant_payouts r JOIN "Order" o ON o.id=r."orderId" WHERE o."userId" = ANY($1)`],
  ['deliveries', `SELECT d.* FROM "Delivery" d WHERE d."orderId" IN (SELECT id FROM "Order" WHERE "userId" = ANY($1)) OR d."delivererId" = ANY($1)`],
];

(async () => {
  const target = describeTarget();
  console.log(`\nBase ciblée : ${target.label}${target.isLocal ? '' : '   ⚠️  NON LOCALE'}\n`);

  if (EMAILS.length === 0) {
    console.log('Aucun e-mail fourni. --emails=a@b.com,c@d.com\n');
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: comptes } = await client.query(
    `SELECT id, email, role FROM "User" WHERE lower(email) = ANY($1) ORDER BY email`,
    [EMAILS],
  );

  const absents = EMAILS.filter(
    (e) => !comptes.some((c) => c.email.toLowerCase() === e),
  );
  if (absents.length) {
    console.log('⚠️  Introuvables : ' + absents.join(', ') + '\n');
  }
  if (comptes.length === 0) {
    await client.end();
    return;
  }

  for (const c of comptes) {
    console.log(`  ${c.email.padEnd(32)} ${c.role}`);
  }
  const ids = comptes.map((c) => c.id);

  console.log('\n── Ce qui sera DÉTRUIT ─────────────────────────────────');
  for (const [label, sql] of INVENTAIRE) {
    const { rows } = await client.query(sql, [ids]);
    console.log(`  ${label.padEnd(36)} ${rows[0].n}`);
  }

  if (!APPLY) {
    console.log('\nLecture seule. Ajouter --apply et --i-understand-this-destroys-accounting.\n');
    await client.end();
    return;
  }
  if (!AVOWED) {
    console.log(
      '\n⛔ --apply seul ne suffit pas. Cet outil détruit des pièces comptables :\n' +
        '   ajouter --i-understand-this-destroys-accounting.\n',
    );
    await client.end();
    return;
  }

  // ── Export AVANT toute écriture ───────────────────────────────────────────
  const dir = path.resolve(__dirname, '../../backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fichier = path.join(dir, `purge-${stamp}.json`);
  const dump = { base: target.label, date: new Date().toISOString(), comptes: EMAILS };
  for (const [nom, sql] of EXPORT) {
    dump[nom] = (await client.query(sql, [ids])).rows;
  }
  fs.writeFileSync(fichier, JSON.stringify(dump, null, 2));
  console.log(`\n💾 Export préalable : ${fichier}`);
  console.log(
    `   ${Object.entries(dump).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}:${v.length}`).join('  ')}`,
  );

  if (!target.isLocal) {
    console.log('\n⚠️  DESTRUCTION sur base NON LOCALE. Ctrl-C dans les 10 secondes.\n');
    await new Promise((r) => setTimeout(r, 10_000));
  }

  await client.query('BEGIN');
  try {
    for (const [nom, sql] of ETAPES) {
      const res = await client.query(sql, [ids]);
      if (res.rowCount) console.log(`  ${nom.padEnd(30)} ${res.rowCount}`);
    }
    await client.query('COMMIT');
    console.log('\n✅ Suppression effectuée.\n');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(
      `\n⛔ ANNULÉ — rien n'a été supprimé.\n   ${e.message}\n` +
        "   Une table manque dans l'ordre de suppression : c'est la contrainte\n" +
        '   RESTRICT du schéma qui vient de le dire. Ajoutez-la à ETAPES.\n',
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error('ERREUR :', e.message);
  process.exit(1);
});
