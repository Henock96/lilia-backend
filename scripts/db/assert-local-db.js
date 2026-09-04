#!/usr/bin/env node
/**
 * Préflight des commandes destructrices de `package.json`.
 *
 * `prisma migrate reset` et `prisma db seed` ne prennent pas d'option de
 * sécurité : ils font ce qu'on leur dit, sur la base que `DATABASE_URL` désigne.
 * Ce script s'exécute **avant** eux et interrompt la chaîne (`&&`) si la cible
 * n'est pas locale.
 *
 *   node scripts/db/assert-local-db.js "réinitialisation complète"
 */
require('../load-env').loadEnv();
const { assertLocalDatabase, describeTarget } = require('./target-database');

const operation = process.argv[2] || 'opération destructrice sur la base';
const target = assertLocalDatabase(operation);

process.stdout.write(`✅ Base locale confirmée : ${target.label}\n`);
