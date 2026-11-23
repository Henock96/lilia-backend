/**
 * Lot 3 — « payez maintenant » : le message envoyé au client quand la boutique
 * accepte sa demande (`DEMANDE_ENVOYEE → EN_ATTENTE`).
 *
 * Un seul texte pour les deux chemins : le listener l'envoie dans la seconde,
 * l'outbox le reprend si ce premier envoi n'a pas abouti. Deux copies
 * divergeraient au premier changement de libellé.
 */
export function requestAcceptedPush(
  order: {
    id: string;
    total: number;
    paymentDueAt: Date | null;
    restaurant: { nom: string };
  },
  now: number = Date.now(),
): {
  title: string;
  body: string;
  data: Record<string, string>;
} {
  const minutes = order.paymentDueAt
    ? Math.max(1, Math.ceil((order.paymentDueAt.getTime() - now) / 60_000))
    : null;
  return {
    title: '✅ Commande acceptée — payez maintenant',
    body:
      `${order.restaurant.nom} a accepté votre commande. Payez ${Math.round(order.total)} FCFA` +
      (minutes ? ` dans les ${minutes} min` : '') +
      ' pour qu’elle soit préparée.',
    data: {
      orderId: order.id,
      type: 'order_update',
      status: 'EN_ATTENTE',
      action: 'pay',
    },
  };
}
