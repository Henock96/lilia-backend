// Amorçage de la grille de livraison plateforme (F3-02) — crée un BROUILLON.
//
// ## Pourquoi ce script existe
//
// Le mode `PLATFORM` refuse de s'allumer sans grille publiée (409), et la
// première grille ne doit pas sortir de nulle part : elle part des prix que
// les clients paient aujourd'hui, pour que la bascule ne change rien de
// visible tant que l'administrateur n'a pas décidé autre chose.
//
// Sans option, le script propose **une tranche unique** au prix médian des
// vendeurs publiés (`fixedDeliveryFee`, ou tarif de zone en `ZONE_BASED`).
// Au 23/09/2026, les 4 vendeurs publiés étaient tous à 1 000 XAF : la
// proposition est donc « 1 000 XAF quelle que soit la distance ».
//
// Des paliers explicites se passent en option :
//
//   --bands "3:1000,6:1500,10:2000"   # jusqu'à 3 km : 1 000, jusqu'à 6 : 1 500…
//   --road-factor 1.3                 # défaut du schéma
//
// ## Ce que le script ne fait JAMAIS
//
// Publier. Il crée un brouillon ; la publication passe par l'admin
// (`POST /admin/delivery-tariffs/:id/publish`), qui la trace dans le journal
// d'audit. Une grille fixe le prix de toutes les commandes et l'assiette de
// la paie livreur : elle se relit (simulateur) avant d'entrer en vigueur.
//
// ## Usage
//
//   npm run db:target                                 # quelle base ?
//   node scripts/db/seed-delivery-tariff.js           # proposition, rien n'est écrit
//   node scripts/db/seed-delivery-tariff.js --apply   # crée le brouillon
const { randomUUID } = require('crypto');
const { loadEnv } = require('../load-env');
const { Client } = require('pg');
const { describeTarget } = require('./target-database');

const APPLY = process.argv.includes('--apply');
/** Au-delà de la dernière tranche, le moteur applique son prix : 50 km couvre la ville. */
const SINGLE_BAND_MAX_KM = 50;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseBands(raw) {
  const bands = raw.split(',').map((part) => {
    const [km, fee] = part.split(':').map((v) => v.trim());
    const maxKm = Number(km);
    const feeXaf = Number(fee);
    if (!(maxKm > 0) || !Number.isInteger(feeXaf) || feeXaf < 0) {
      throw new Error(`Tranche illisible : « ${part} » (attendu km:prix).`);
    }
    return { maxKm, feeXaf };
  });
  const kms = new Set(bands.map((b) => b.maxKm));
  if (kms.size !== bands.length) {
    throw new Error('Deux tranches ont la même borne.');
  }
  return bands.sort((a, b) => a.maxKm - b.maxKm);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function main() {
  loadEnv();
  const target = describeTarget();
  console.log(`Base : ${target.label}`);

  const roadFactor = Number(argValue('--road-factor') ?? 1.3);
  if (!(roadFactor >= 1 && roadFactor <= 3)) {
    throw new Error('--road-factor doit être entre 1 et 3.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Les prix pratiqués aujourd'hui, vendeurs publiés seulement : un vendeur
    // en cours de configuration n'a encore rien facturé.
    const { rows: vendors } = await client.query(
      `SELECT r.nom, r."deliveryPriceMode" AS mode, r."fixedDeliveryFee" AS fixed,
              coalesce(array_agg(z.fee) FILTER (WHERE z.id IS NOT NULL), '{}') AS zone_fees
         FROM "Restaurant" r
         LEFT JOIN "DeliveryZone" z ON z."restaurantId" = r.id
        WHERE r."isActive" AND r."adminApproved" AND r."onboardingStatus" = 'ACTIVATED'
        GROUP BY r.id ORDER BY r.nom`,
    );
    const observed = vendors.flatMap((v) =>
      v.mode === 'ZONE_BASED' && v.zone_fees.length ? v.zone_fees : [v.fixed],
    );
    console.log('\nPrix pratiqués par les vendeurs publiés :');
    for (const v of vendors) {
      const zones = v.zone_fees.length ? ` · zones ${v.zone_fees.join('/')}` : '';
      console.log(`  - ${v.nom} : ${v.mode} ${v.fixed} XAF${zones}`);
    }

    const rawBands = argValue('--bands');
    let bands;
    if (rawBands) {
      bands = parseBands(rawBands);
    } else {
      if (observed.length === 0) {
        throw new Error(
          'Aucun vendeur publié : rien à reprendre. Passez --bands explicitement.',
        );
      }
      bands = [{ maxKm: SINGLE_BAND_MAX_KM, feeXaf: median(observed) }];
    }

    const { rows: published } = await client.query(
      `SELECT version FROM "DeliveryTariff" WHERE status = 'PUBLISHED'`,
    );
    const { rows: maxRows } = await client.query(
      `SELECT coalesce(max(version), 0)::int AS v FROM "DeliveryTariff"`,
    );
    const version = maxRows[0].v + 1;

    console.log(`\nProposition — brouillon v${version}, coefficient routier ${roadFactor} :`);
    let from = 0;
    for (const b of bands) {
      console.log(`  ${from} → ${b.maxKm} km : ${b.feeXaf} XAF`);
      from = b.maxKm;
    }
    if (published.length) {
      console.log(`  (grille en vigueur : v${published[0].version}, inchangée)`);
    }

    if (!APPLY) {
      console.log('\nRien n’a été écrit. Relancez avec --apply pour créer le brouillon.');
      return;
    }

    await client.query('BEGIN');
    const id = randomUUID();
    await client.query(
      `INSERT INTO "DeliveryTariff"
         (id, version, status, "roadFactor", note, "createdBy", "createdAt", "updatedAt")
       VALUES ($1, $2, 'DRAFT', $3, $4, 'script:seed-delivery-tariff', now(), now())`,
      [
        id,
        version,
        roadFactor,
        rawBands
          ? 'Amorçage : paliers passés en option'
          : 'Amorçage : prix médian des vendeurs publiés',
      ],
    );
    for (const b of bands) {
      await client.query(
        `INSERT INTO "DeliveryTariffBand" (id, "tariffId", "maxKm", "feeXaf")
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), id, b.maxKm, b.feeXaf],
      );
    }
    await client.query('COMMIT');
    console.log(`\nBrouillon v${version} créé (${id}). À relire et publier depuis l'admin.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
