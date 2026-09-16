#!/usr/bin/env node
/**
 * Banc de mesure — allers-retours Redis sur le chemin critique (P0-2).
 *
 * ## Ce que ce banc mesure, et ce qu'il ne mesure pas
 *
 * Il **ne mesure pas** la latence de production : le Redis de production est à
 * ~271 ms de l'instance Render, ce poste n'y a pas accès, et aucune écriture ne
 * doit y être faite. Il reproduit donc le **mécanisme** : un Redis local réel,
 * plus une latence artificielle injectée par commande, pour comparer ce qui est
 * comparable — le nombre d'allers-retours.
 *
 * C'est le nombre d'allers-retours qui est la grandeur corrigée. La latence
 * unitaire, elle, est une donnée d'infrastructure (T1–T4, `OPS REQUIRED`).
 *
 * ## Ce qu'il compare
 *
 *   1. throttler  : 2 × EVAL en série  ← avant   vs  en parallèle  ← après
 *   2. tracking   : GEOADD + SETEX + SET NX en série  vs  un pipeline
 *
 * ## Usage
 *
 *   node scripts/bench/redis-roundtrips.js [--url redis://…] [--rtt 271] [--runs 12]
 *
 * `--rtt` est la latence simulée d'un aller-retour, en millisecondes. Par
 * défaut 271 ms : la valeur mesurée depuis Render par deux instruments
 * indépendants le 08/09/2026.
 *
 * Aucune donnée réelle n'est lue ni écrite : les clés sont préfixées
 * `__bench__` et supprimées à la fin.
 */
'use strict';

const Redis = require('ioredis');

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const URL = readFlag('url', process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const SIMULATED_RTT_MS = Number(readFlag('rtt', '271'));
const RUNS = Number(readFlag('runs', '12'));
const PREFIX = '__bench__';

/** Latence injectée : la moitié à l'aller, la moitié au retour n'a pas de sens
 *  ici — on ajoute le trajet complet une fois par commande, ce qui est ce que
 *  paie réellement un appel bloquant. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enveloppe `sendCommand` pour ajouter la latence simulée à chaque commande.
 *
 * Posée sur l'instance et non sur le prototype : le banc doit pouvoir comparer
 * un client « lointain » et un client local dans le même processus.
 */
function withSimulatedLatency(client, rttMs) {
  if (!rttMs) return client;
  const original = client.sendCommand.bind(client);
  client.sendCommand = function patched(command) {
    // ⚠️ `Redis.prototype.sendCommand` rend **la promesse** de la commande
    // (`command.promise`), pas l'objet `Command`. Réassigner `result.promise`
    // n'a donc aucun effet — premier essai, silencieusement inopérant : le banc
    // affichait 0,3 ms avec une latence censée valoir 271 ms.
    const result = original(command);
    return isThenable(result) ? delay(rttMs).then(() => result) : result;
  };

  // Un pipeline n'appelle pas `sendCommand` de façon observable : ioredis
  // regroupe les commandes en **une seule** écriture sur la socket et les
  // résout depuis `exec()`. Sans ce second point d'accroche, le banc affichait
  // 0,2 ms pour la version pipelinée — c'est-à-dire « gratuit », ce qui est
  // faux : un pipeline coûte bien un aller-retour. On le modélise donc
  // explicitement : un trajet, une fois.
  const originalPipeline = client.pipeline.bind(client);
  client.pipeline = function patchedPipeline(...args) {
    const built = originalPipeline(...args);
    const originalExec = built.exec.bind(built);
    built.exec = (...execArgs) =>
      delay(rttMs).then(() => originalExec(...execArgs));
    return built;
  };

  return client;
}

const isThenable = (value) => Boolean(value) && typeof value.then === 'function';

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

async function time(fn) {
  const startedAt = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

async function measure(label, fn) {
  // Un tour à blanc : la première commande paie l'établissement de connexion.
  await fn();
  const samples = [];
  for (let i = 0; i < RUNS; i += 1) samples.push(await time(fn));
  return { label, median: median(samples), p95: p95(samples) };
}

// ─── Scénario 1 : les deux limiteurs du ThrottlerGuard ──────────────────────
// `@nest-lab/throttler-storage-redis` fait un EVAL par limiteur. Le script Lua
// réel ne nous intéresse pas ici : ce qu'on compare, c'est le nombre de trajets.
const LUA_INCR = `
  local hits = redis.call('INCR', KEYS[1])
  if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return hits
`;

async function throttlerSerial(redis) {
  await redis.eval(LUA_INCR, 1, `${PREFIX}:short`, 1000);
  await redis.eval(LUA_INCR, 1, `${PREFIX}:long`, 60000);
}

async function throttlerParallel(redis) {
  await Promise.all([
    redis.eval(LUA_INCR, 1, `${PREFIX}:short`, 1000),
    redis.eval(LUA_INCR, 1, `${PREFIX}:long`, 60000),
  ]);
}

// ─── Scénario 2 : les trois écritures de position du tracking ───────────────
async function trackingSerial(redis) {
  await redis.geoadd(`${PREFIX}:positions`, 15.2429, -4.2634, 'driver');
  await redis.setex(`${PREFIX}:delivery`, 300, '{"lat":-4.2634}');
  await redis.set(`${PREFIX}:lock`, '1', 'EX', 60, 'NX');
}

async function trackingPipelined(redis) {
  await redis
    .pipeline()
    .geoadd(`${PREFIX}:positions`, 15.2429, -4.2634, 'driver')
    .setex(`${PREFIX}:delivery`, 300, '{"lat":-4.2634}')
    .set(`${PREFIX}:lock`, '1', 'EX', 60, 'NX')
    .exec();
}

function render(rows) {
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const row of rows) {
    console.log(
      `  ${row.label.padEnd(width)}  médiane ${row.median.toFixed(1).padStart(7)} ms` +
        `   p95 ${row.p95.toFixed(1).padStart(7)} ms   (${row.roundTrips} aller-retour${row.roundTrips > 1 ? 's' : ''})`,
    );
  }
}

async function main() {
  const redis = withSimulatedLatency(new Redis(URL), SIMULATED_RTT_MS);

  try {
    await redis.ping();
  } catch (err) {
    console.error(`Redis injoignable sur ${URL} : ${err.message}`);
    process.exit(1);
  }

  console.log(
    `\nBanc allers-retours Redis — ${RUNS} tours, latence simulée ${SIMULATED_RTT_MS} ms/commande`,
  );
  console.log(`Cible : ${URL.replace(/\/\/.*@/, '//***@')}\n`);

  console.log('ThrottlerGuard — deux limiteurs (short 10/s + long 100/min)');
  render([
    { ...(await measure('AVANT  — 2 EVAL en série', () => throttlerSerial(redis))), roundTrips: 2 },
    { ...(await measure('APRÈS  — 2 EVAL en parallèle', () => throttlerParallel(redis))), roundTrips: 1 },
  ]);

  console.log('\nTracking — écriture de position (toutes les 5 s par livreur)');
  render([
    { ...(await measure('AVANT  — 3 commandes en série', () => trackingSerial(redis))), roundTrips: 3 },
    { ...(await measure('APRÈS  — 1 pipeline', () => trackingPipelined(redis))), roundTrips: 1 },
  ]);

  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
