// Purge des comptes SANS AUCUNE TRACE MÉTIER. Lecture seule par défaut.
//
// ## Pourquoi ce script existe, et pourquoi il est aussi restrictif
//
// `DELETE FROM "User"` échoue sur 18 contraintes `RESTRICT`, et c'est voulu :
// une commande livrée et encaissée est une pièce comptable. `UserDeletionService`
// répond au besoin normal — suppression à l'initiative d'un client — par une
// **anonymisation**, qui coupe le lien à l'identité sans effacer le chiffre
// d'affaires.
//
// Reste un cas que l'anonymisation ne couvre pas : les comptes de test, ou les
// inscriptions qui n'ont jamais rien produit. Eux n'ont aucune valeur
// comptable, et les anonymiser laisserait 50 lignes fantômes dans la base.
//
// ## La garantie
//
// Un compte n'est supprimé que s'il n'a **aucune** ligne dans les dix tables
// qui portent une valeur métier ou opposable :
//
//   Order · Restaurant · driver_settlements · PromoUsage · LoyaltyTransaction
//   ReferralReward (parrain OU filleul) · DeliveryReview (client OU livreur)
//   DeliveryAssignment · Delivery · AdminAuditLog
//
// ⚠️ Cette condition est **revérifiée DANS la transaction de suppression**, pas
// seulement à l'affichage. Entre le moment où l'opérateur lit la liste et celui
// où il valide, un de ces comptes peut avoir passé commande — c'est une base de
// production, elle vit pendant qu'on la regarde. Sans cette relecture, le
// script supprimerait une commande fraîche.
//
// Ce qui part avec le compte (données personnelles, aucune valeur comptable) :
// adresses, panier, favoris, tokens FCM, avis vendeur, installations, profil
// livreur. C'est exactement le périmètre qu'efface déjà `UserDeletionService`.
//
// ## Usage
//
//   node scripts/db/purge-traceless-users.js                 # liste, n'écrit rien
//   node scripts/db/purge-traceless-users.js --apply         # supprime
//   node scripts/db/purge-traceless-users.js --apply --only=id1,id2
//   node scripts/db/purge-traceless-users.js --include-admins # lève la garde ADMIN
//
// ⚠️ Vérifier la base ciblée AVANT : `npm run db:target`.

require('../load-env').loadEnv();
const { Client } = require('pg');
const { describeTarget } = require('./target-database');

const APPLY = process.argv.includes('--apply');
const INCLUDE_ADMINS = process.argv.includes('--include-admins');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '')
  .replace('--only=', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Les dix tables dont une seule ligne suffit à protéger un compte.
 *
 * Écrites une fois, utilisées deux fois : à l'affichage et dans la
 * revérification transactionnelle. Deux copies de cette liste finiraient par
 * diverger, et c'est la copie oubliée qui laisserait passer une suppression.
 */
const TRACES = `
  NOT EXISTS (SELECT 1 FROM "Order"              x WHERE x."userId"        = u.id)
  AND NOT EXISTS (SELECT 1 FROM "Restaurant"         x WHERE x."ownerId"       = u.id)
  AND NOT EXISTS (SELECT 1 FROM driver_settlements   x WHERE x."driverId"      = u.id)
  AND NOT EXISTS (SELECT 1 FROM "PromoUsage"         x WHERE x."userId"        = u.id)
  AND NOT EXISTS (SELECT 1 FROM "LoyaltyTransaction" x WHERE x."userId"        = u.id)
  AND NOT EXISTS (SELECT 1 FROM "ReferralReward"     x WHERE x."referrerId"    = u.id
                                                        OR x."referredUserId" = u.id)
  AND NOT EXISTS (SELECT 1 FROM "DeliveryReview"     x WHERE x."userId"        = u.id
                                                        OR x."delivererId"    = u.id)
  AND NOT EXISTS (SELECT 1 FROM "DeliveryAssignment" x WHERE x."delivererId"   = u.id)
  AND NOT EXISTS (SELECT 1 FROM "Delivery"           x WHERE x."delivererId"   = u.id)
  AND NOT EXISTS (SELECT 1 FROM "AdminAuditLog"      x WHERE x."actorId"       = u.id)
`;

/**
 * Satellites effacés avec le compte, dans l'ordre des dépendances.
 *
 * `CartItem` avant `Cart` : la cascade existe en base, mais l'écrire ici rend
 * l'ordre lisible plutôt que dépendant d'une propriété du schéma.
 * `DeviceInstallation` et `DriverProfile` sont en `CASCADE` — inutile de les
 * lister, PostgreSQL s'en charge.
 */
const SATELLITES = [
  ['CartItem', 'DELETE FROM "CartItem" WHERE "cartId" IN (SELECT id FROM "Cart" WHERE "userId" = ANY($1))'],
  ['Cart', 'DELETE FROM "Cart" WHERE "userId" = ANY($1)'],
  ['Adresses', 'DELETE FROM "Adresses" WHERE "userId" = ANY($1)'],
  ['Favorite', 'DELETE FROM "Favorite" WHERE "userId" = ANY($1)'],
  ['FcmToken', 'DELETE FROM "FcmToken" WHERE "userId" = ANY($1)'],
  ['Review', 'DELETE FROM "Review" WHERE "userId" = ANY($1)'],
];

(async () => {
  const target = describeTarget();
  console.log(
    `\nBase ciblée : ${target.label}${target.isLocal ? '' : '   ⚠️  NON LOCALE'}\n`,
  );

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const filtreOnly = ONLY.length ? 'AND u.id = ANY($1)' : '';
  const params = ONLY.length ? [ONLY] : [];

  const { rows } = await client.query(
    `SELECT u.id, u.email, u.role, u."statusUser", u."createdAt"::date AS d,
            u."lastLogin"
       FROM "User" u
      WHERE ${TRACES} ${filtreOnly}
      ORDER BY u."createdAt"`,
    params,
  );

  const admins = rows.filter((r) => r.role === 'ADMIN');
  const cibles = INCLUDE_ADMINS ? rows : rows.filter((r) => r.role !== 'ADMIN');

  for (const r of cibles) {
    console.log(
      `  ${String(r.email).slice(0, 38).padEnd(38)} ${String(r.role).padEnd(12)} ` +
        `${r.d.toISOString().slice(0, 10)}  ${r.lastLogin ? 'connecté' : 'jamais connecté'}`,
    );
  }
  console.log(`\n${cibles.length} compte(s) sans aucune trace métier.`);

  if (admins.length && !INCLUDE_ADMINS) {
    console.log(
      `\n⚠️  ${admins.length} compte(s) ADMIN exclu(s) de la purge : ` +
        admins.map((a) => a.email).join(', '),
    );
    console.log(
      "   Un administrateur sans commande reste un administrateur. `--include-admins` lève la garde.",
    );
  }

  if (!APPLY) {
    console.log('\nLecture seule. Relancer avec --apply pour supprimer.\n');
    await client.end();
    return;
  }

  if (cibles.length === 0) {
    await client.end();
    return;
  }

  if (!target.isLocal) {
    console.log(
      `\n⚠️  SUPPRESSION DÉFINITIVE de ${cibles.length} compte(s) sur une base NON LOCALE.` +
        '\n    Ctrl-C dans les 10 secondes pour annuler.\n',
    );
    await new Promise((r) => setTimeout(r, 10_000));
  }

  const ids = cibles.map((r) => r.id);
  await client.query('BEGIN');
  try {
    // ⚠️ Revérification DANS la transaction. La liste affichée date d'il y a
    // quelques secondes ; sur une base de production, un de ces comptes a pu
    // passer commande entre-temps. On ne supprime que ce qui est encore sans
    // trace au moment de l'écriture, et le verrou `FOR UPDATE` empêche qu'une
    // commande s'insère pendant qu'on décide.
    const { rows: confirmes } = await client.query(
      `SELECT u.id FROM "User" u WHERE u.id = ANY($1) AND ${TRACES} FOR UPDATE`,
      [ids],
    );
    const sursis = ids.length - confirmes.length;
    if (sursis > 0) {
      console.log(
        `\n⚠️  ${sursis} compte(s) ont acquis une trace métier depuis l'affichage — épargné(s).`,
      );
    }
    const finaux = confirmes.map((r) => r.id);

    if (finaux.length === 0) {
      await client.query('ROLLBACK');
      console.log('Rien à supprimer.\n');
      await client.end();
      return;
    }

    for (const [nom, sql] of SATELLITES) {
      const res = await client.query(sql, [finaux]);
      if (res.rowCount) console.log(`  ${nom.padEnd(20)} ${res.rowCount} ligne(s)`);
    }
    const res = await client.query('DELETE FROM "User" WHERE id = ANY($1)', [
      finaux,
    ]);
    await client.query('COMMIT');
    console.log(`\n✅ ${res.rowCount} compte(s) supprimé(s) définitivement.\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error('ERREUR :', e.message);
  process.exit(1);
});
