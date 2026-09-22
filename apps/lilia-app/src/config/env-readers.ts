/**
 * Lectures d'environnement pour le code qui s'exécute **avant** `ConfigModule`.
 *
 * `instrument.ts` doit rester le tout premier import de `main.ts` : Sentry
 * s'installe avant que les autres modules ne soient chargés. Il n'a donc accès
 * ni aux bornes du schéma Joi, ni à sa convention `.empty('')` qui traduit
 * « vide » en « non posée » — la validation n'a pas encore eu lieu.
 *
 * Ces deux lecteurs rejouent cette convention à la main, pour que le contrat
 * soit le même des deux côtés de la frontière.
 */

/**
 * Fraction d'échantillonnage Sentry, ou le défaut.
 *
 * ⚠️ `process.env.X ?? '0.1'` ne rattrape que `undefined`. Une variable **posée
 * mais vide** — la forme que `.env.example` documente — donne `''`, et
 * `parseFloat('')` vaut `NaN`. Sentry refuse un taux non numérique et abandonne
 * **toutes** les transactions : le traçage s'éteint en silence au lieu de valoir
 * les 0,1 annoncés. Le fichier censé aider un opérateur lui apprenait à couper
 * le traçage.
 *
 * Hors `[0, 1]` ⇒ défaut également : `10` saisi au lieu de `0.1` est une erreur
 * d'unité fréquente, et l'accepter tracerait dix fois chaque requête.
 */
export function readSampleRate(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number(raw);
  // `Number('')` vaut 0 : on exige donc une valeur non vide AVANT de convertir,
  // sinon une variable vide serait lue comme un taux de 0 — traçage éteint, mais
  // silencieusement et sans repli.
  if (!raw?.trim() || !Number.isFinite(parsed)) return fallback;
  if (parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

/**
 * Texte facultatif, où une chaîne vide vaut « absente ».
 *
 * Sans cela, `environment: process.env.SENTRY_ENVIRONMENT ?? NODE_ENV` rend
 * `''` dès que la variable est posée vide : Sentry range alors les événements
 * sous un environnement sans nom, au lieu de retomber sur `NODE_ENV`.
 */
export function readOptionalText(raw: string | undefined): string | undefined {
  return raw?.trim() ? raw.trim() : undefined;
}
