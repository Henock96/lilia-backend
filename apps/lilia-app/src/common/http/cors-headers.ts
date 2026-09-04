/**
 * En-têtes de requête que les clients ont le droit d'envoyer (CORS).
 *
 * ## Pourquoi cette liste vit dans son propre fichier
 *
 * Elle était écrite en dur dans `main.ts`, et un en-tête ajouté côté client ne
 * rencontrait donc jamais rien qui rappelle qu'il fallait l'y déclarer. Le
 * 31 août 2026, `packages/api-client` s'est mis à envoyer
 * `X-Lilia-Payment-Flow` sur **chaque** requête ; personne n'a touché au CORS.
 *
 * Le défaut qui en résulte est particulièrement silencieux : le préflight
 * répond `204` avec des en-têtes CORS parfaitement corrects, mais le
 * navigateur constate que la requête réelle porte un en-tête absent de
 * `Access-Control-Allow-Headers` et **refuse de l'émettre**. Côté serveur,
 * rien n'est en erreur — la requête n'arrive tout simplement jamais. Côté
 * client, `fetch` rejette avec un `TypeError: Failed to fetch` que React Query
 * traite comme un incident réseau ordinaire : pas de message, pas de trace.
 *
 * Mesuré sur l'administration déployée le 4 septembre 2026 : tableau de bord
 * bloqué en squelettes, « Aucun vendeur » sur `/vendeurs`, alors que le même
 * appel, joué depuis la console sans cet en-tête, renvoyait les six vendeurs.
 *
 * ## La règle
 *
 * **Tout en-tête personnalisé ajouté dans `packages/api-client/src/client.ts`
 * doit être ajouté ici dans le même changement.** `cors-allowed-headers.spec.ts`
 * fige la correspondance et nomme le fichier client à mettre à jour.
 */
export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',

  /** Idempotence du checkout — `POST /orders/checkout`. */
  'Idempotency-Key',

  /**
   * Capacité d'encaissement déclarée par le client, lue par
   * `PaymentController.createPayment`. Un client qui ne l'annonce pas se voit
   * refuser l'ouverture d'un encaissement piloté par le prestataire (426).
   *
   * ⚠️ Envoyé par `apiClient` sur **toutes** les requêtes, pas seulement les
   * routes de paiement : l'omettre ici casse l'intégralité des deux
   * applications web, pas seulement le paiement.
   */
  'X-Lilia-Payment-Flow',
] as const;
