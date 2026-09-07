import { defineConfig } from 'prisma/config'
import { loadEnv } from './scripts/load-env'

/**
 * Environnement du **CLI Prisma** — même cascade que l'application.
 *
 * ## Ce que faisait `import 'dotenv/config'`, et pourquoi c'était grave
 *
 * `dotenv/config` ne lit que `.env` — c'est-à-dire, dans ce dépôt, les
 * identifiants de **production** (Neon). Deux chargeurs coexistaient donc, et
 * ils ne répondaient pas la même chose :
 *
 * | Chemin | Chargeur | Cible |
 * |---|---|---|
 * | application (`ConfigModule`) et `scripts/db/*` | cascade | `localhost/lilia_dev` |
 * | **CLI Prisma** | `dotenv/config` → `.env` seul | **production** |
 *
 * `npm run db:target` annonçait « localhost/lilia_dev » pendant que
 * `npx prisma migrate status`, dans le même dépôt à la même seconde, parlait à
 * Neon. Autrement dit : `prisma migrate dev` écrivait en production, et
 * `migrate dev` propose spontanément un `reset` dès que la base locale a
 * dérivé. Le garde-fou de `scripts/db/target-database.js` ne couvre pas le
 * CLI — il protège les scripts maison, pas les commandes Prisma.
 *
 * `loadEnv()` applique la cascade de `ConfigModule`, dans le même ordre :
 *
 *   1. `.env.local`          surcharges du poste, non versionné
 *   2. `.env.<NODE_ENV>`     base et Redis locaux, versionné, sans secret
 *   3. `.env`                secrets, non versionné
 *
 * ## L'invariant qui protège la production
 *
 * ⚠️ `loadEnv()` charge avec `override: false` : **ce qui est déjà dans
 * `process.env` n'est jamais réécrit**. C'est ce qui rend le déploiement
 * Render sûr — `npm run render-build` lance `prisma migrate deploy` avec le
 * `DATABASE_URL` du service, et aucun fichier ne peut le supplanter. Ne jamais
 * passer ce chargement en `override: true`.
 *
 * Corollaire utile en local : `DATABASE_URL="…" npx prisma migrate diff …`
 * continue de viser exactement ce qu'on lui donne.
 */
loadEnv()

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
    // Base jetable utilisée par `prisma migrate dev` / `migrate diff` pour
    // rejouer le dossier de migrations et en déduire l'état réel. Sans elle,
    // `migrate diff --from-migrations` refuse de s'exécuter (Prisma 7).
    // Locale et facultative : en CI comme en production, seul
    // `migrate deploy` tourne, et il ne l'utilise pas.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
  migrations: {
    // `npx prisma db seed` — seed de DÉVELOPPEMENT, destructif par nature
    // (TRUNCATE de toutes les tables métier). Le script refuse lui-même de
    // tourner sur une base qui ressemble à la production : le garde-fou vit
    // dans le code, pas dans la mémoire de celui qui lance la commande.
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts',
  },
})
