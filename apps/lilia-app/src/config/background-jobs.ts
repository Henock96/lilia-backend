/**
 * Ce processus doit-il exécuter les tâches de fond (crons + dépilage outbox) ?
 *
 * Jusqu'ici, tout tournait dans le processus web : les 5 crons et le
 * dispatcher outbox partageaient l'event loop avec les requêtes HTTP. À faible
 * volume c'est invisible ; à l'heure de pointe, un lot de notifications entre
 * en concurrence avec les checkouts.
 *
 * Le flag permet de séparer les rôles sans rien casser :
 *
 *   Aujourd'hui (un seul service Render)
 *     web : RUN_BACKGROUND_JOBS non défini → true → comportement inchangé
 *
 *   Après déploiement du worker
 *     web    : RUN_BACKGROUND_JOBS=false
 *     worker : RUN_BACKGROUND_JOBS=true
 *
 * Le défaut est `true` **volontairement** : si quelqu'un déploie sans lire
 * cette note, les crons continuent de tourner. Un défaut à `false` ferait
 * silencieusement disparaître l'expiration des commandes et les rappels de
 * précommande — une panne invisible, bien pire qu'une redondance.
 *
 * La redondance, elle, est sans danger : `CronLockService` pose un verrou
 * Redis `SET NX` par job, donc deux processus ne font jamais le travail deux
 * fois.
 */
export function shouldRunBackgroundJobs(): boolean {
  return process.env.RUN_BACKGROUND_JOBS !== 'false';
}
