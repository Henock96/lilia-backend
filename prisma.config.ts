import 'dotenv/config'
import { defineConfig } from 'prisma/config'

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