// LECTURE SEULE — exécute prisma/scripts/audit-orphans.sql et affiche le résultat.
require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const sql = fs.readFileSync('prisma/scripts/audit-orphans.sql', 'utf-8');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Session en lecture seule : toute écriture accidentelle serait refusée.
  await client.query('SET default_transaction_read_only = on');
  const res = await client.query(sql);
  const bad = res.rows.filter((r) => Number(r.orphelins) > 0);
  console.log(`Relations auditées : ${res.rows.length}`);
  console.log(`Relations avec orphelins : ${bad.length}\n`);
  for (const r of bad) console.log(`  ${String(r.orphelins).padStart(6)}  ${r.relation}`);
  if (!bad.length) console.log('  Aucune ligne orpheline — la base accepte les FK en l\'état.');
  await client.end();
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
