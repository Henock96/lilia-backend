/**
 * Instantané du contrat HTTP de l'API (durcissement lot 5, 5A).
 *
 * Construit le document OpenAPI **sans démarrer l'application** : Nest en mode
 * `preview` résout le graphe des modules sans instancier les providers, donc
 * sans base, sans Redis, sans Firebase. Le document est trié puis écrit dans
 * `openapi/openapi.snapshot.json`.
 *
 *   npm run openapi:snapshot          # régénère l'instantané
 *   npm run openapi:check             # échoue si le contrat a changé sans lui
 *
 * Un changement de route, de DTO ou de code de statut apparaît ainsi dans la
 * PR, là où les cinq clients peuvent être évalués (règle 19).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Valeurs factices, posées seulement si absentes : la validation de
 * configuration s'exécute à l'import d'`AppModule`, mais le mode `preview`
 * n'instancie aucun provider — aucune ne sert à se connecter. Jamais de
 * secret ici, et rien de réel n'est contacté (ports fermés).
 */
const PREVIEW_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://openapi@127.0.0.1:1/openapi',
  REDIS_URL: 'redis://127.0.0.1:1',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  PAYMENT_MODE: 'MANUAL',
  LILIA_PAYMENT_PHONE: '060000000',
  FIREBASE_PROJECT_ID: 'openapi-snapshot',
  FIREBASE_CLIENT_EMAIL: 'openapi@openapi-snapshot.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: 'openapi-snapshot-sans-cle',
};
for (const [k, v] of Object.entries(PREVIEW_ENV)) process.env[k] ??= v;

const OUTPUT = join(__dirname, '..', '..', 'openapi', 'openapi.snapshot.json');

/** Tri récursif des clés : l'instantané ne varie qu'avec le contrat. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

async function main() {
  // Chargé après les variables ci-dessus : la validation s'exécute à l'import.
  const { AppModule } = await import('../../apps/lilia-app/src/app.module');
  const app = await NestFactory.create(AppModule, {
    preview: true,
    // Une erreur de graphe doit remonter dans `main().catch`, avec sa cause,
    // et non arrêter le processus en silence.
    abortOnError: false,
    logger: ['error'],
  });
  const config = new DocumentBuilder()
    .setTitle('Lilia Food API')
    .setDescription('API de la plateforme de livraison Lilia Food')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const json = `${JSON.stringify(sortKeys(document), null, 2)}\n`;

  if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== json) {
      console.error(
        '✖ Le contrat OpenAPI a changé : lancez `npm run openapi:snapshot`, ' +
          'committez openapi/openapi.snapshot.json et évaluez les cinq clients.',
      );
      process.exit(1);
    }
    console.log('✔ Contrat OpenAPI identique à l’instantané.');
  } else {
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, json);
    console.log(
      `✔ ${Object.keys(document.paths).length} chemins écrits dans ${OUTPUT}`,
    );
  }
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
