/**
 * Environnements **déployés** : ceux qu'on atteint depuis Internet.
 *
 * La préproduction (`staging`) porte une copie des données de production et
 * accepte les vrais comptes Firebase. Pour tout ce qui touche à l'exposition —
 * CORS, Swagger, détail de `/health`, format des journaux — elle se comporte
 * donc comme la production, jamais comme un poste de développement.
 *
 * ⚠️ Ce module ne doit rien importer : `main.ts` et `instrument.ts` le lisent
 * avant `ConfigModule`.
 */
export const DEPLOYED_ENVIRONMENTS = ['production', 'staging'] as const;

export function isDeployedEnvironment(nodeEnv: string | undefined): boolean {
  return (DEPLOYED_ENVIRONMENTS as readonly string[]).includes(nodeEnv ?? '');
}

/**
 * Origines CORS admises.
 *
 * Déployé : liste blanche stricte, et refus de démarrer si elle est vide —
 * refléter toute origine avec `credentials: true` est une faille (CSRF,
 * exfiltration cross-site), pas un défaut de confort. Ailleurs : toute origine.
 */
export function resolveCorsOrigin(
  nodeEnv: string | undefined,
  rawAllowedOrigins: string | undefined,
): string[] | true {
  if (!isDeployedEnvironment(nodeEnv)) return true;

  const origins = (rawAllowedOrigins ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error(
      `ALLOWED_ORIGINS doit être défini en ${nodeEnv} (liste blanche CORS). ` +
        'Ex: ALLOWED_ORIGINS=https://lilia-food.com,https://admin.lilia-food.com',
    );
  }
  return origins;
}
