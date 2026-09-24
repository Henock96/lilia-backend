import { OrderStatus } from '@prisma/client';

import { ORDER_TRANSITION_MATRIX, OrderActor } from './order-state.machine';

/**
 * Gestes qu'une interface peut proposer sur une commande — publiés par le
 * serveur (règle R1 du blueprint Phase 3).
 *
 * ## Pourquoi
 *
 * Trois interfaces recopiaient `ORDER_TRANSITION_MATRIX` à la main et avaient
 * divergé (audit du 22/09/2026) : boutons toujours refusés en 400/403, bouton
 * « En route » inatteignable par construction. Une quatrième copie n'aurait
 * rien réglé. Le serveur dit désormais lui-même ce qu'il acceptera.
 *
 * ## Comment
 *
 * La liste est DÉRIVÉE de la matrice — jamais réécrite — puis filtrée par les
 * règles propres aux routes (`OrderLifecycleService`) :
 *  - `PAYER` ne se déclare pas (F-07) et `EN_ROUTE` n'existe que par la
 *    récupération livreur ;
 *  - `ACCEPTEE` passe par « Accepter » (temps de préparation obligatoire) ;
 *  - un refus d'une commande payée ou acceptée est un « Refuser » motivé ;
 *  - la remise au comptoir n'existe que pour une commande à emporter ;
 *  - « Préparer » depuis `PAYER` disparaît quand l'acceptation est en service ;
 *  - une course en route ne se conclut pas par le statut de la COMMANDE, même
 *    pour l'ADMIN : la livraison resterait `EN_TRANSIT` et le livreur
 *    `ON_DELIVERY` — l'arbitrage passe par la livraison (`ADMIN_OVERRIDE`).
 *
 * `order-allowed-actions.spec.ts` vérifie, sur toutes les combinaisons, que
 * tout geste publié est accepté par le serveur.
 *
 * Ce n'est PAS un contrôle d'accès : les routes revérifient tout. C'est
 * l'honnêteté de l'interface.
 */
export const ORDER_ACTIONS = [
  'ACCEPT',
  'REJECT',
  'START_PREPARATION',
  'MARK_READY',
  'HAND_OVER',
  'CANCEL',
] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

/** Statut d'arrivée d'un geste. */
export function actionTarget(action: OrderAction): OrderStatus {
  switch (action) {
    case 'ACCEPT':
      return 'ACCEPTEE';
    case 'START_PREPARATION':
      return 'EN_PREPARATION';
    case 'MARK_READY':
      return 'PRET';
    case 'HAND_OVER':
      return 'LIVRER';
    case 'REJECT':
    case 'CANCEL':
      return 'ANNULER';
  }
}

const ACTORS: readonly OrderActor[] = [
  'CLIENT',
  'RESTAURATEUR',
  'ADMIN',
  'LIVREUR',
];

export function orderAllowedActions(
  order: { status: OrderStatus; isDelivery: boolean },
  role: string,
  opts: { acceptanceRequired: boolean },
): OrderAction[] {
  const actor = ACTORS.find((a) => a === role);
  // Le livreur agit sur la LIVRAISON (accepter, récupérer, remettre avec le
  // code), jamais sur le statut de la commande.
  if (!actor || actor === 'LIVREUR') return [];

  const from = order.status;
  const targets = Object.entries(ORDER_TRANSITION_MATRIX[from] ?? {})
    .filter(([, actors]) => actors?.includes(actor))
    .map(([to]) => to as OrderStatus);

  const actions: OrderAction[] = [];
  for (const to of targets) {
    const action = actionFor(from, to, actor, order.isDelivery, opts);
    if (action && !actions.includes(action)) actions.push(action);
  }
  return actions;
}

function actionFor(
  from: OrderStatus,
  to: OrderStatus,
  actor: OrderActor,
  isDelivery: boolean,
  opts: { acceptanceRequired: boolean },
): OrderAction | null {
  switch (to) {
    case 'ACCEPTEE':
      return 'ACCEPT';
    case 'EN_PREPARATION':
      return from === 'PAYER' && opts.acceptanceRequired
        ? null
        : 'START_PREPARATION';
    case 'PRET':
      return 'MARK_READY';
    case 'LIVRER':
      return from === 'PRET' && !isDelivery ? 'HAND_OVER' : null;
    case 'ANNULER':
      return actor !== 'CLIENT' && (from === 'PAYER' || from === 'ACCEPTEE')
        ? 'REJECT'
        : 'CANCEL';
    default:
      // PAYER, EN_ROUTE, ECHEC_LIVRAISON : jamais depuis une interface.
      return null;
  }
}

/** Contexte plateforme dont dépendent les gestes (lu une fois par requête). */
export interface OrderActionContext {
  acceptanceRequired: boolean;
}

/** Lit l'interrupteur d'acceptation ; sans ligne de réglages, il est éteint. */
export async function readActionContext(prisma: {
  platformSettings: {
    findUnique(args: {
      where: { id: string };
      select: { orderAcceptanceRequired: true };
    }): Promise<{ orderAcceptanceRequired: boolean } | null>;
  };
}): Promise<OrderActionContext> {
  const settings = await prisma.platformSettings.findUnique({
    where: { id: 'singleton' },
    select: { orderAcceptanceRequired: true },
  });
  return { acceptanceRequired: settings?.orderAcceptanceRequired ?? false };
}

/** Ajoute à chaque commande les gestes que CE rôle peut y faire. */
export function withAllowedActions<
  T extends { status: OrderStatus; isDelivery: boolean },
>(
  orders: T[],
  role: string,
  context: OrderActionContext,
): Array<T & { allowedActions: OrderAction[] }> {
  return orders.map((order) => ({
    ...order,
    allowedActions: orderAllowedActions(order, role, context),
  }));
}
