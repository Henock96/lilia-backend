/* eslint-disable @typescript-eslint/no-require-imports */

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Garde « le CLI Prisma vise la même base que l'application ».
 *
 * ## Le défaut couvert
 *
 * `prisma.config.ts` chargeait son environnement avec `import 'dotenv/config'`,
 * qui ne lit que `.env` — c'est-à-dire, dans ce dépôt, les identifiants de
 * **production**. L'application et les scripts maison, eux, passaient par la
 * cascade de `scripts/load-env.js`. Résultat, dans le même dépôt à la même
 * seconde :
 *
 * ```
 * npm run db:target        → localhost/lilia_dev
 * npx prisma migrate status → neondb @ …neon.tech      (production)
 * ```
 *
 * Autrement dit, `prisma migrate dev` écrivait en production — et il propose
 * spontanément un `reset` dès que la base locale a dérivé. Le garde-fou de
 * `scripts/db/target-database.js` ne pouvait rien : il protège les scripts
 * maison, pas les commandes du CLI Prisma.
 *
 * ## Ce que cette suite vérifie, et pourquoi ces deux propriétés
 *
 * 1. **La divergence elle-même** — un contrôle textuel, volontairement grossier.
 *    Il ne prouve pas que le chargement est correct ; il empêche le retour du
 *    geste exact qui a créé le problème, y compris par copier-coller depuis un
 *    autre dépôt.
 * 2. **L'invariant qui protège la production** — `loadEnv()` ne doit jamais
 *    écraser ce qui est déjà dans `process.env`. C'est lui, et lui seul, qui
 *    rend `prisma migrate deploy` sûr sur Render : la plateforme pose
 *    `DATABASE_URL`, aucun fichier du dépôt ne peut le supplanter. Celui-là est
 *    un vrai test de comportement.
 */
describe('Environnement du CLI Prisma', () => {
  const ROOT = join(__dirname, '..', '..', '..');

  describe('prisma.config.ts — la cascade partagée, pas `.env` seul', () => {
    /**
     * Le fichier **sans ses commentaires**.
     *
     * Sa documentation cite le geste fautif (« chargeait son environnement avec
     * `import 'dotenv/config'` ») : chercher cette chaîne dans le fichier entier
     * ferait échouer le test sur l'explication du correctif, pas sur le
     * correctif. Un contrôle qui interdit de *parler* du problème n'aide
     * personne — c'est le code qu'on inspecte.
     */
    const code = readFileSync(join(ROOT, 'prisma.config.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') // blocs, y compris JSDoc
      .replace(/^\s*\/\/.*$/gm, ''); // lignes de commentaire entières

    it("n'importe pas `dotenv`, qui ne lit que `.env` (production)", () => {
      expect(code).not.toMatch(/from\s+['"]dotenv/);
      expect(code).not.toMatch(/import\s+['"]dotenv/);
      expect(code).not.toMatch(/require\(\s*['"]dotenv/);
    });

    it('charge la même cascade que `ConfigModule` et les scripts maison', () => {
      expect(code).toMatch(/scripts\/load-env/);
      expect(code).toMatch(/loadEnv\(\)/);
    });

    it('le dépouillement des commentaires ne vide pas le fichier', () => {
      // Sans cette garde, une expression rationnelle trop gourmande rendrait
      // les deux tests ci-dessus vrais pour de mauvaises raisons.
      expect(code).toMatch(/defineConfig/);
      expect(code).toMatch(/process\.env\.DATABASE_URL/);
    });
  });

  describe('loadEnv() — ce qui est déjà posé ne bouge jamais', () => {
    const { loadEnv } = require('../../../scripts/load-env') as {
      loadEnv: () => void;
    };

    const SNAPSHOT = { ...process.env };
    afterEach(() => {
      process.env = { ...SNAPSHOT };
    });

    it("n'écrase pas un `DATABASE_URL` venu de la plateforme (Render)", () => {
      // `npm run render-build` lance `prisma migrate deploy` avec le
      // `DATABASE_URL` du service. Si un fichier du dépôt pouvait le
      // supplanter, le déploiement migrerait la mauvaise base.
      const platform = 'postgresql://u:p@db.render.example:5432/prod_db';
      process.env.DATABASE_URL = platform;

      loadEnv();

      expect(process.env.DATABASE_URL).toBe(platform);
    });

    it("n'écrase pas non plus une cible passée en ligne de commande", () => {
      // `DATABASE_URL="…" npx prisma migrate diff …` doit viser exactement ce
      // qu'on lui donne — c'est le geste par lequel on valide une migration
      // sur une base jetable.
      const jetable = 'postgresql://u@localhost:5432/lilia_migration_check';
      process.env.DATABASE_URL = jetable;

      loadEnv();

      expect(process.env.DATABASE_URL).toBe(jetable);
    });

    it('est idempotent — le rejouer ne change rien', () => {
      loadEnv();
      const apresPremierAppel = process.env.DATABASE_URL;

      loadEnv();

      expect(process.env.DATABASE_URL).toBe(apresPremierAppel);
    });
  });
});
