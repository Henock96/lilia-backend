// LECTURE SEULE — commandes reversables dont la commission figée vaut 0.
//
// ## Pourquoi ce script existe
//
// `Order.commissionPercent` est un **snapshot** : le reversement vendeur lit ce
// qui a été figé à la commande, et ne résout plus aucun taux (voir
// `restaurant-payout.service.ts`). C'est la bonne architecture — un chiffre
// comptable ne se recalcule pas.
//
// Mais elle a été posée le 17/09/2026, et les commandes **antérieures** portent
// `commissionPercent = 0` : à l'époque, le checkout retombait sur `0` pendant
// que le reversement, lui, résolvait le taux plateforme et prélevait 10 %. Les
// deux disaient des choses différentes.
//
// Conséquence concrète, et c'est tout l'objet de ce script : **tout reversement
// déclenché aujourd'hui sur une de ces commandes prélèvera 0 % de commission.**
// Silencieusement, et sans que rien ne soit en erreur — le code fait exactement
// ce qu'on lui demande.
//
// ## Deux populations, deux natures de correction
//
// Le script les sépare, parce qu'elles n'engagent pas la même chose :
//
// **(A) Commandes DÉJÀ reversées.** Il existe un `RestaurantPayout` `SUCCESS`
// qui porte le taux **réellement prélevé**. Recopier ce taux sur la commande
// n'invente rien : c'est une **réconciliation**, qui fait dire à la commande ce
// que le virement a effectivement fait. C'est ce que `--apply` corrige.
//
// **(B) Commandes PAS encore reversées.** Aucun virement n'existe, donc aucune
// vérité à recopier. Poser un taux ici serait une **décision comptable** — elle
// fixe ce que la plateforme prélèvera sur des commandes déjà encaissées, et le
// taux actuel du vendeur décrit ses commandes futures, pas celles-là. Le script
// les chiffre et **ne les touche jamais**, même avec `--apply`.
//
// ## Usage
//
//   node scripts/db/audit-zero-commission.js            # lecture seule (défaut)
//   node scripts/db/audit-zero-commission.js --apply    # réconcilie (A) seulement
//
// ⚠️ Vérifier la base ciblée AVANT : `npm run db:target`.

require('dotenv').config();
const { Client } = require('pg');

/** Statuts à partir desquels un vendeur peut être reversé. */
const PAYOUT_ELIGIBLE = ['PRET', 'EN_ROUTE', 'LIVRER'];

const SQL = `
  SELECT
    o."id",
    o."createdAt"::date        AS jour,
    r."nom"                    AS vendeur,
    o."subTotal",
    o."commissionPercent",
    r."commissionPercent"      AS taux_vendeur_actuel,
    p."id"                     AS reversement_id,
    p."status"                 AS reversement_statut
  FROM "Order" o
  JOIN "Restaurant" r ON r."id" = o."restaurantId"
  LEFT JOIN "restaurant_payouts" p ON p."orderId" = o."id"
  WHERE o."commissionPercent" = 0
    AND o."status" = ANY($1)
    AND EXISTS (
      SELECT 1 FROM "payments" pay
      WHERE pay."orderId" = o."id" AND pay."status" = 'SUCCESS'
    )
  ORDER BY o."createdAt" ASC
`;

const xaf = (n) => `${Math.round(Number(n)).toLocaleString('fr-FR')} XAF`;

const APPLY = process.argv.includes('--apply');

/**
 * Réconciliation de la population (A) : la commande adopte le taux que le
 * virement a réellement appliqué.
 *
 * `commissionAmount` est recalculé depuis `subTotal` et non recopié depuis le
 * reversement : les deux doivent être cohérents entre eux, et c'est la commande
 * qui porte le sous-total. Conditionné sur `commissionPercent = 0` — rejouer le
 * script ne réécrit rien.
 */
const RECONCILE_SQL = `
  UPDATE "Order" o
  SET "commissionPercent" = p."commissionPercent",
      "commissionAmount"  = ROUND(o."subTotal" * p."commissionPercent" / 100.0)
  FROM "restaurant_payouts" p
  WHERE p."orderId" = o."id"
    AND p."status" = 'SUCCESS'
    AND o."commissionPercent" = 0
    AND p."commissionPercent" > 0
  RETURNING o."id"
`;

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Toute écriture accidentelle serait refusée par la session elle-même.
  await client.query('SET default_transaction_read_only = on');

  const { rows } = await client.query(SQL, [PAYOUT_ELIGIBLE]);
  await client.end();
  // ⚠️ La connexion de LECTURE est fermée ici. Une éventuelle écriture ouvre sa
  // propre connexion plus bas : la session d'audit reste en lecture seule de
  // bout en bout, et aucune faute de frappe ne peut la rendre écrivante.

  if (rows.length === 0) {
    console.log(
      'Aucune commande reversable ne porte une commission figée à 0 — rien à arbitrer.',
    );
    return;
  }

  const dejaPayees = rows.filter((r) => r.reversement_statut === 'SUCCESS');
  const aPayer = rows.filter((r) => r.reversement_statut !== 'SUCCESS');

  const manqueA = (liste) =>
    liste.reduce(
      (somme, r) =>
        somme + (Number(r.subTotal) * Number(r.taux_vendeur_actuel ?? 0)) / 100,
      0,
    );

  console.log(
    `\n${rows.length} commande(s) encaissée(s) et reversable(s) portent commissionPercent = 0.\n`,
  );

  console.log('── (A) Déjà reversées — RÉCONCILIABLES ────────────────────────');
  console.log(
    `  ${dejaPayees.length} commande(s). Le virement porte le taux réellement`,
  );
  console.log(
    '  prélevé ; la commande dit 0 %. Recopier le premier sur la seconde ne',
  );
  console.log(
    `  décide de rien — c'est la commande qui ment. ${APPLY ? 'Correction EN COURS.' : 'Relancer avec --apply.'}\n`,
  );

  console.log('── (B) PAS encore reversées — DÉCISION COMPTABLE ──────────────');
  console.log(
    `  ${aPayer.length} commande(s) — commission qui serait perdue : ~${xaf(manqueA(aPayer))}`,
  );
  console.log(
    '  Les reverser en l\'état prélèvera 0 %. Poser le taux avant reversement\n' +
      '  suppose d\'écrire sur des commandes passées — décision comptable.\n',
  );

  console.log('── Détail des commandes non reversées ─────────────────────────');
  for (const r of aPayer) {
    const taux = Number(r.taux_vendeur_actuel ?? 0);
    console.log(
      `  ${r.jour.toISOString().slice(0, 10)}  ${r.id}  ${String(r.vendeur).slice(0, 22).padEnd(22)}` +
        `  sous-total ${String(xaf(r.subTotal)).padStart(14)}` +
        `  taux vendeur actuel ${taux} %`,
    );
  }

  if (APPLY) {
    const w = new Client({ connectionString: process.env.DATABASE_URL });
    await w.connect();
    const res = await w.query(RECONCILE_SQL);
    await w.end();
    console.log(
      `\n✅ ${res.rowCount} commande(s) réconciliée(s) sur le taux de leur reversement.`,
    );
  }

  console.log(
    '\n⚠️ Le « taux vendeur actuel » décrit les commandes FUTURES de ce vendeur.\n' +
      '   L\'appliquer rétroactivement est un choix : il peut avoir changé depuis.\n' +
      '   Ce script ne le fera JAMAIS, même avec --apply.\n',
  );
})().catch((e) => {
  console.error('ERREUR :', e.message);
  process.exit(1);
});
