/**
 * Typages de `scripts/load-env.js`.
 *
 * Le module reste en CommonJS : il est appelé par `node -e "require(…)"` depuis
 * les scripts npm (`db:target`, `db:seed`, `db:reset:dev`), qui ne passent par
 * aucun transpileur. Ce fichier existe pour que `prisma.config.ts` puisse
 * l'importer sans activer `allowJs` sur tout le programme TypeScript.
 */
export declare function loadEnv(): void;
