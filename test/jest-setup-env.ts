/**
 * Environnement minimal pour les tests unitaires.
 *
 * Certains specs importent un module Nest dont le décorateur `@Module` appelle
 * `ConfigModule.forRoot({ validationSchema })` — `apps/worker/src/worker.module.ts`
 * en particulier. La validation Joi tourne alors **à l'import du fichier**,
 * bien avant `describe()`, et lève si les variables requises manquent : le
 * process enfant de Jest meurt, sans qu'aucune assertion n'ait été évaluée.
 *
 * En local le `.env` à la racine remplissait ces variables par accident (Config
 * le charge depuis `process.cwd()`), donc la suite passait. En CI il n'y a pas
 * de `.env` : le seul spec concerné échouait, uniquement sur GitHub.
 *
 * Ces valeurs sont factices et ne servent qu'à franchir la validation : aucun
 * test unitaire n'ouvre de connexion (Prisma, Redis et Firebase sont mockés).
 * Elles sont posées avec `??=` pour qu'une valeur déjà fournie par
 * l'environnement l'emporte.
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/lilia_test';
process.env.FIREBASE_PROJECT_ID ??= 'lilia-test';
process.env.FIREBASE_CLIENT_EMAIL ??= 'test@lilia-test.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY ??= 'test-private-key';
