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
//   node scripts/db/purge-traceless-users.js --apply --emails=a@b.com,c@d.com
//   node scripts/db/purge-traceless-users.js --apply --only=id1,id2
//   node scripts/db/purge-traceless-users.js --include-admins # lève la garde ADMIN
//   node scripts/db/purge-traceless-users.js --with-dead-orders
//
// ## `--emails` plutôt que `--only`
//
// Les deux existent, mais `--emails` est celui à employer. Une liste de `cuid`
// est illisible : ni l'opérateur qui lance la commande, ni l'outillage qui
// l'encadre ne peut vérifier ce qu'elle désigne. Sur une suppression définitive
// en production, une portée invérifiable est un défaut à part entière — on ne
// valide pas ce qu'on ne peut pas lire.
//
// ## `--with-dead-orders` : la seule concession, et ses sept conditions
//
// Un compte porteur d'une commande est protégé, c'est la règle. Ce drapeau
// l'assouplit pour un cas précis : une commande **annulée qui n'a jamais rien
// encaissé** n'a aucune valeur comptable — elle n'entre dans aucun chiffre
// d'affaires, aucun tableau de bord vendeur, aucune statistique.
//
// Elle n'est emportée que si TOUTES ces conditions tiennent, revérifiées dans la
// transaction : statut `ANNULER`, aucun encaissement réussi, aucune livraison,
// aucun remboursement, aucun reversement, aucun usage de code promo, aucune
// écriture de fidélité, aucune récompense de parrainage. Une seule ligne dans
// l'une de ces tables, et le compte redevient protégé.
//
// ⚠️ Vérifier la base ciblée AVANT : `npm run db:target`.

require('../load-env').loadEnv();
const { Client } = require('pg');
const { describeTarget } = require('./target-database');

const APPLY = process.argv.includes('--apply');
const INCLUDE_ADMINS = process.argv.includes('--include-admins');
const WITH_DEAD_ORDERS = process.argv.includes('--with-dead-orders');

const listeArg = (nom) =>
  (process.argv.find((a) => a.startsWith(`--${nom}=`)) ?? '')
    .replace(`--${nom}=`, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const ONLY = listeArg('only');
const EMAILS = listeArg('emails');

/**
 * Une commande sans aucune valeur comptable.
 *
 * Écrite une fois, utilisée deux fois — à l'affichage et dans la transaction.
 * Deux copies de cette liste finiraient par diverger, et c'est la copie oubliée
 * qui laisserait passer une suppression.
 */
const COMMANDE_MORTE = `
  o."status" = 'ANNULER'
  AND NOT EXISTS (SELECT 1 FROM payments             x WHERE x."orderId" = o.id AND x.status = 'SUCCESS')
  AND NOT EXISTS (SELECT 1 FROM "Delivery"           x WHERE x."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "Refund"             x WHERE x."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM restaurant_payouts   x WHERE x."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "PromoUsage"         x WHERE x."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "LoyaltyTransaction" x WHERE x."orderId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM "ReferralReward"     x WHERE x."orderId" = o.id)
`;

/**
 * La clause qui protège les comptes porteurs d'une commande.
 *
 * Sans `--with-dead-orders` : toute commande protège. Avec : seules les
 * commandes qui ne sont PAS mortes protègent encore.
 */
const clauseOrder = WITH_DEAD_ORDERS
  ? `NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."userId" = u.id AND NOT (${COMMANDE_MORTE}))`
  : `NOT EXISTS (SELECT 1 FROM "Order" x WHERE x."userId" = u.id)`;

/**
 * Les dix tables dont une seule ligne suffit à protéger un compte.
 *
 * Écrites une fois, utilisées deux fois : à l'affichage et dans la
 * revérification transactionnelle. Deux copies de cette liste finiraient par
 * diverger, et c'est la copie oubliée qui laisserait passer une suppression.
 */
const TRACES = `
  ${clauseOrder}
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

/**
 * Commandes mortes emportées avec leur compte, quand `--with-dead-orders`.
 *
 * ⚠️ La condition `COMMANDE_MORTE` est **réappliquée ici**, dans la même
 * transaction que la suppression. Elle l'a déjà été à la sélection du compte,
 * mais une commande n'est pas figée : entre les deux, un encaissement peut
 * aboutir. Faire confiance au filtre amont reviendrait à supprimer une commande
 * qui vient de recevoir de l'argent.
 *
 * `OrderItem` avant `Order` : la FK est en `RESTRICT`, PostgreSQL refuserait
 * l'ordre inverse. `OrderHistory` est en `CASCADE`, `Review.orderId` en
 * `SET NULL` — ni l'un ni l'autre n'a besoin d'être listé.
 */
const COMMANDES_MORTES = [
  [
    'OrderItem',
    `DELETE FROM "OrderItem" WHERE "orderId" IN
       (SELECT o.id FROM "Order" o WHERE o."userId" = ANY($1) AND ${COMMANDE_MORTE})`,
  ],
  [
    'Order',
    `DELETE FROM "Order" o WHERE o."userId" = ANY($1) AND ${COMMANDE_MORTE}`,
  ],
];

(async () => {
  const target = describeTarget();
  console.log(
    `\nBase ciblée : ${target.label}${target.isLocal ? '' : '   ⚠️  NON LOCALE'}\n`,
  );

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let filtre = '';
  const params = [];
  if (EMAILS.length) {
    params.push(EMAILS);
    filtre = `AND lower(u.email) = ANY($${params.length})`;
  } else if (ONLY.length) {
    params.push(ONLY);
    filtre = `AND u.id = ANY($${params.length})`;
  }

  const { rows } = await client.query(
    `SELECT u.id, u.email, u.role, u."statusUser", u."createdAt"::date AS d,
            u."lastLogin",
            (SELECT COUNT(*) FROM "Order" o WHERE o."userId" = u.id)::int AS commandes
       FROM "User" u
      WHERE ${TRACES} ${filtre}
      ORDER BY u."createdAt"`,
    params,
  );

  // ⚠️ Un e-mail demandé qui ne ressort pas est une information, pas un détail.
  // Il signifie soit « ce compte n'existe pas », soit — bien plus important —
  // « ce compte porte une trace métier et a été protégé ». Se taire laisserait
  // croire à une suppression qui n'a pas eu lieu.
  if (EMAILS.length) {
    const rendus = new Set(rows.map((r) => r.email.toLowerCase()));
    const absents = EMAILS.filter((e) => !rendus.has(e.toLowerCase()));
    if (absents.length) {
      console.log(
        `⚠️  ${absents.length} e-mail(s) demandé(s) NON retenu(s) — inexistants, ` +
          'ou porteurs d’une trace métier qui les protège :',
      );
      for (const e of absents) console.log(`      ${e}`);
      console.log('');
    }
  }

  const admins = rows.filter((r) => r.role === 'ADMIN');
  const cibles = INCLUDE_ADMINS ? rows : rows.filter((r) => r.role !== 'ADMIN');

  for (const r of cibles) {
    console.log(
      `  ${String(r.email).slice(0, 38).padEnd(38)} ${String(r.role).padEnd(12)} ` +
        `${r.d.toISOString().slice(0, 10)}  ${(r.lastLogin ? 'connecté' : 'jamais connecté').padEnd(16)}` +
        // Le nombre de commandes est affiché même quand il vaut 0 : sous
        // `--with-dead-orders`, c'est la seule façon de voir qu'une commande
        // part avec le compte.
        `${r.commandes > 0 ? `commande morte emportée (${r.commandes})` : ''}`,
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

    // Les commandes mortes AVANT les satellites : `OrderItem` référence des
    // `Product`, pas le compte, mais l'ordre reste celui des dépendances.
    if (WITH_DEAD_ORDERS) {
      for (const [nom, sql] of COMMANDES_MORTES) {
        const res = await client.query(sql, [finaux]);
        if (res.rowCount) {
          console.log(`  ${nom.padEnd(20)} ${res.rowCount} ligne(s)  [commande morte]`);
        }
      }
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
