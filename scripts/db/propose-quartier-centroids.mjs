#!/usr/bin/env node
/**
 * Propose — et n'applique que sur demande explicite — les centroïdes des
 * quartiers de Brazzaville qui en manquent.
 *
 * Pourquoi ce script existe plutôt qu'une migration : une migration s'applique
 * sans relecture, alors que ces coordonnées demandent un arbitrage humain.
 * Sept des douze quartiers restants n'ont **aucune** source fiable, et les
 * remplir « pour finir le tableau » produirait une carte qui a l'air juste et
 * envoie le livreur ailleurs.
 *
 * Le raisonnement complet, source par source, est dans
 * `docs/01-architecture/quartiers-centroides.md`. Ne pas ajouter de ligne ici
 * sans y ajouter la sienne là-bas.
 *
 *   node scripts/db/propose-quartier-centroids.mjs           # lecture seule
 *   node scripts/db/propose-quartier-centroids.mjs --apply   # écriture
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Candidats retenus. `source` et `confiance` ne sont pas décoratifs : ce sont
 * eux qui permettent de rejuger la décision dans six mois.
 *
 * Sont volontairement ABSENTS — et doivent le rester tant qu'aucune source ne
 * désigne le quartier lui-même : Bifouiti, Mpissa, Saint-Pierre, La Tsiémé,
 * Texaco, Massengo, Kinsoundi.
 */
const CANDIDATS = [
  {
    nom: 'Moukondo',
    latitude: -4.23157,
    longitude: 15.268009,
    source: 'OpenStreetMap — place=neighbourhood « Moukondo, Moungali »',
    confiance: 'bonne',
  },
  {
    nom: 'Nkombo',
    latitude: -4.191861,
    longitude: 15.246704,
    source: 'OpenStreetMap — place=neighbourhood « Nkombo, Djiri »',
    confiance: 'bonne',
  },
  {
    nom: 'Marché Total',
    latitude: -4.289723,
    longitude: 15.249223,
    source: 'OpenStreetMap — amenity=marketplace « Marché Total Bacongo »',
    confiance: 'moyenne — le marché nomme le quartier, son emprise est plus petite',
  },
  {
    nom: 'Mfilou',
    latitude: -4.217716,
    longitude: 15.218801,
    source: 'OpenStreetMap — boundary=administrative « Mfilou (arrondissement 7) »',
    confiance: 'faible — centroïde d’arrondissement, écart possible de plusieurs km',
  },
  {
    nom: 'Djiri',
    latitude: -4.160482,
    longitude: 15.274245,
    source: 'OpenStreetMap — boundary=administrative « Djiri (arrondissement 9) »',
    confiance: 'faible — centroïde d’arrondissement, écart possible de plusieurs km',
  },
];

/** Mêmes bornes que `common/geo/congo-geo.ts`. Une divergence serait un bug. */
const CONGO = { minLat: -5.5, maxLat: 3.8, minLng: 10.5, maxLng: 19.0 };

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) {
    throw new Error('DATABASE_URL absent et aucun .env trouvé.');
  }
  const line = fs
    .readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL absent du .env.');
  return line.trim().slice('DATABASE_URL='.length).replace(/^["']|["']$/g, '');
}

function valide({ latitude, longitude }) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    !(Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001) &&
    latitude >= CONGO.minLat &&
    latitude <= CONGO.maxLat &&
    longitude >= CONGO.minLng &&
    longitude <= CONGO.maxLng
  );
}

const apply = process.argv.includes('--apply');

const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();

try {
  const { rows: all } = await client.query(
    'SELECT id, nom, latitude, longitude FROM "Quartier" ORDER BY nom',
  );
  const avec = all.filter((q) => q.latitude !== null && q.longitude !== null);

  console.log(`\nBase : ${new URL(databaseUrl()).host}`);
  console.log(`Quartiers : ${all.length}   avec centroïde : ${avec.length}   sans : ${all.length - avec.length}`);

  if (all.length === 0) {
    console.log('\n⚠️  Aucun quartier en base. Lancer le seed avant.');
    process.exit(0);
  }

  console.log(`\n── Candidats (${CANDIDATS.length}) ──`);
  const aEcrire = [];

  for (const c of CANDIDATS) {
    const q = all.find((r) => r.nom === c.nom);
    if (!q) {
      console.log(`  ⛔ ${c.nom.padEnd(16)} introuvable en base (nom différent ?)`);
      continue;
    }
    if (q.latitude !== null && q.longitude !== null) {
      console.log(`  ⏭  ${c.nom.padEnd(16)} a déjà un centroïde — laissé intact`);
      continue;
    }
    if (!valide(c)) {
      console.log(`  ⛔ ${c.nom.padEnd(16)} coordonnées hors bornes Congo — refusé`);
      continue;
    }
    console.log(
      `  ✅ ${c.nom.padEnd(16)} ${c.latitude}, ${c.longitude}\n` +
        `     source    : ${c.source}\n` +
        `     confiance : ${c.confiance}`,
    );
    aEcrire.push({ ...c, id: q.id });
  }

  const restants = all.filter(
    (q) => q.latitude === null && !aEcrire.some((c) => c.id === q.id),
  );
  if (restants.length) {
    console.log(
      `\n── Laissés en UNKNOWN, délibérément (${restants.length}) ──\n  ` +
        restants.map((q) => q.nom).join(', ') +
        '\n  Aucune source ne désigne le quartier lui-même. Un centroïde absent\n' +
        '  dégrade en UNKNOWN, ce que les quatre clients savent afficher ;\n' +
        '  un mauvais centroïde produit une carte qui a l’air juste.',
    );
  }

  if (!apply) {
    console.log(
      `\nLecture seule. Pour écrire les ${aEcrire.length} candidat(s) :\n` +
        '  node scripts/db/propose-quartier-centroids.mjs --apply\n' +
        '  (relire docs/01-architecture/quartiers-centroides.md avant)\n',
    );
    process.exit(0);
  }

  for (const c of aEcrire) {
    await client.query(
      'UPDATE "Quartier" SET latitude = $1, longitude = $2 WHERE id = $3 AND latitude IS NULL',
      [c.latitude, c.longitude, c.id],
    );
    console.log(`  écrit : ${c.nom}`);
  }
  console.log(`\n${aEcrire.length} centroïde(s) posé(s).\n`);
} finally {
  await client.end();
}
