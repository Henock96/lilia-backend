/**
 * Noms des limiteurs de débit, partagés entre leur déclaration (`AppModule`) et
 * les routes qui s'en exemptent (`@SkipThrottle`).
 *
 * ⚠️ Pourquoi cette constante existe (P-04, 08/09/2026) : `ThrottlerGuard` ne
 * lit pas une clé d'exemption unique, il lit `THROTTLER:SKIP` **suffixée du nom
 * du limiteur** :
 *
 * ```js
 * this.reflector.getAllAndOverride(THROTTLER_SKIP + namedThrottler.name, …)
 * ```
 *
 * Or `@SkipThrottle()` sans argument écrit la clé `THROTTLER:SKIPdefault`. Sur
 * des limiteurs **nommés** — les nôtres le sont — cette clé n'est jamais lue :
 * le décorateur a l'air correct, se relit correctement, et n'exempte
 * strictement rien. Il faut nommer chaque limiteur explicitement.
 *
 * Passer par cette constante rend l'erreur impossible : renommer un limiteur
 * sans mettre à jour les exemptions casse la compilation au lieu de rétablir
 * silencieusement le throttling sur les routes exemptées.
 */
export const THROTTLER_SHORT = 'short';
export const THROTTLER_LONG = 'long';

/** À passer à `@SkipThrottle(...)` pour exempter une route de tous les limiteurs. */
export const SKIP_ALL_THROTTLERS: Record<string, boolean> = {
  [THROTTLER_SHORT]: true,
  [THROTTLER_LONG]: true,
};
