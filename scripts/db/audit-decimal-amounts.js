// LECTURE SEULE — recense les montants XAF non entiers avant la migration M12.
//
// La migration `Float -> Int` applique `round()`. Sur des colonnes dont toutes
// les valeurs sont déjà entières, c'est un no-op ; sur une valeur à virgule,
// c'est une **perte d'information silencieuse**. Ce script dit laquelle des
// deux situations on a, au lieu de le supposer.
//
// Usage : DATABASE_URL=… node scripts/db/audit-decimal-amounts.js
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

/** Colonnes converties par la migration M12. */
const COLONNES = [
  ['Order', 'subTotal'],
  ['Order', 'deliveryFee'],
  ['Order', 'serviceFee'],
  ['Order', 'total'],
  ['Order', 'discountAmount'],
  ['Order', 'commissionAmount'],
  ['OrderItem', 'prix'],
  ['OrderItem', 'snapshotPrice'],
  ['payments', 'amount'],
  ['payments', 'collectionFeeXaf'],
  ['restaurant_payouts', 'grossAmount'],
  ['restaurant_payouts', 'commissionAmount'],
  ['restaurant_payouts', 'amount'],
  ['restaurant_payouts', 'payoutFeeXaf'],
  ['Refund', 'amount'],
  ['PromoCode', 'maxDiscount'],
  ['PromoCode', 'minOrderAmount'],
  ['PromoUsage', 'discountApplied'],
];

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Toute écriture accidentelle serait refusée par le moteur.
  await client.query('SET default_transaction_read_only = on');

  let totalDecimaux = 0;
  const absentes = [];

  for (const [table, col] of COLONNES) {
    let res;
    try {
      res = await client.query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE "${col}" IS NOT NULL
                                   AND "${col}" <> round("${col}"::numeric)) ::int AS decimaux,
                min("${col}") AS min, max("${col}") AS max
           FROM "${table}"`,
      );
    } catch (e) {
      // Colonne absente = base en retard sur les migrations. C'est une
      // information, pas une panne : on la remonte au lieu de s'arrêter.
      absentes.push(`${table}.${col} (${e.code})`);
      continue;
    }
    const { n, decimaux, min, max } = res.rows[0];
    totalDecimaux += decimaux;
    const drapeau = decimaux > 0 ? '  ⚠️ ' : '     ';
    console.log(
      `${drapeau}${(table + '.' + col).padEnd(38)} ${String(n).padStart(6)} lignes` +
        `  ${String(decimaux).padStart(4)} décimales` +
        (n > 0 ? `   [${min} … ${max}]` : ''),
    );
  }

  if (absentes.length) {
    console.log(`\nColonnes absentes (base en retard) : ${absentes.join(', ')}`);
  }
  console.log(
    totalDecimaux === 0
      ? '\n✔ Aucun montant décimal : la conversion Float → Int ne perd rien.'
      : `\n⚠️  ${totalDecimaux} montant(s) décimaux — la conversion les ARRONDIRA.`,
  );

  await client.end();
  process.exitCode = totalDecimaux === 0 ? 0 : 2;
})().catch((e) => {
  console.error('ERREUR :', e.message);
  process.exit(1);
});
