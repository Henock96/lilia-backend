/**
 * Dry-run de la migration `enable_foreign_keys` sur la base réelle.
 *
 * Exécute le SQL **dans une transaction volontairement annulée** (`ROLLBACK`) :
 * la base n'est pas modifiée, mais PostgreSQL valide réellement le nettoyage et
 * les 45 contraintes. C'est la seule façon de savoir si la migration passera au
 * déploiement sans la jouer pour de bon.
 *
 *   node scripts/db/dry-run-fk-migration.js
 */
require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

const MIGRATION =
  'prisma/migrations/20260827120000_enable_foreign_keys/migration.sql';

(async () => {
  const sql = fs.readFileSync(MIGRATION, 'utf-8');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query('BEGIN');
  try {
    const started = Date.now();
    await client.query(sql);

    // Compte les contraintes visibles *dans* la transaction.
    const { rows } = await client.query(`
      SELECT COUNT(*)::int AS n
      FROM pg_constraint
      WHERE contype = 'f'
        AND connamespace = 'public'::regnamespace
    `);
    console.log(`✅ Migration jouée sans erreur en ${Date.now() - started} ms`);
    console.log(`   Clés étrangères présentes dans la transaction : ${rows[0].n}`);
  } catch (err) {
    console.error('❌ La migration ÉCHOUERAIT au déploiement :');
    console.error(`   ${err.message}`);
    if (err.detail) console.error(`   ${err.detail}`);
    process.exitCode = 1;
  } finally {
    // Rien n'est conservé : la base ressort inchangée.
    await client.query('ROLLBACK');
    await client.end();
    console.log('↩️  ROLLBACK — la base n\'a pas été modifiée.');
  }
})();
