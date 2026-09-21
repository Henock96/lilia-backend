import { AsyncLocalStorage } from 'node:async_hooks';

interface Store {
  requestId: string;
}

const storage = new AsyncLocalStorage<Store>();

/**
 * Identifiant de la requête HTTP en cours, disponible sans être transmis.
 *
 * ## Le trajet complet d'une corrélation
 *
 * ```
 * client ──X-Request-Id──▶ pinoHttp.genReqId ──▶ RequestContext (ici)
 *                                │                      │
 *                     réponse ◀──┘                      ├─▶ journaux
 *                     X-Request-Id                      ├─▶ OutboxEvent.payload
 *                                                       └─▶ métadonnées prestataire
 * ```
 *
 * Les deux premiers maillons existaient : `genReqId` réutilise un identifiant
 * entrant ou en fabrique un, le renvoie au client, et chaque ligne de journal
 * de la requête le porte. Ce module ajoute les trois suivants — c'est-à-dire
 * tout ce qui survit à la requête.
 *
 * ## Pourquoi `AsyncLocalStorage`
 *
 * L'alternative — faire descendre l'identifiant en paramètre — traverserait une
 * dizaine de signatures de services qui n'ont aucune raison métier de le
 * connaître, et la première méthode qui oublierait de le transmettre romprait
 * la chaîne **en silence**. `AsyncLocalStorage` est le mécanisme prévu par Node
 * pour cela : le contexte suit la continuation asynchrone.
 *
 * ## Ce qu'il ne fait PAS
 *
 * Il ne franchit aucune frontière de processus. Un événement d'outbox dépilé
 * par le worker n'a plus de contexte — d'où `RequestContext.requestId()` qui
 * rend `undefined`, et l'identifiant **écrit dans la charge utile** de
 * l'outbox, seule forme durable de la corrélation.
 *
 * `undefined` est une réponse légitime et fréquente : un cron n'a pas de
 * requête d'origine, et le prétendre serait faux.
 */
export const RequestContext = {
  /** Exécute `fn` dans un périmètre portant cet identifiant. */
  run<T>(requestId: string, fn: () => T): T {
    return storage.run({ requestId }, fn);
  },

  /** Identifiant courant, ou `undefined` hors requête (cron, worker, test). */
  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};
