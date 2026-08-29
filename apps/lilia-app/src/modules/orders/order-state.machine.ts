/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

export type OrderActor = 'CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR';

/**
 * Matrice des transitions : `depuis → { vers: acteurs autorisés }`.
 *
 * Elle remplace le couple `ORDER_TRANSITIONS` + `TRANSITION_PERMISSIONS`
 * (audit du 28/08/2026). Les permissions n'étaient indexées que par l'état
 * d'arrivée, ce qui rendait deux règles impossibles à exprimer :
 *
 *  - **H5** — le CLIENT pouvait annuler une commande DÉJÀ PAYÉE. Le système
 *    rendait stock, points et code promo, mais la ligne `Payment` restait
 *    `SUCCESS`, aucun remboursement n'était créé et aucune tâche admin n'était
 *    ouverte : de l'argent encaissé pour une commande annulée, sans trace.
 *    L'annulation après paiement est désormais réservée à l'ADMIN, qui ouvre
 *    un `Refund` (cf. RefundsService).
 *
 *  - **M16** — aucune sortie vers `ANNULER` après `EN_PREPARATION`. Un vendeur
 *    en rupture ou un livreur introuvable laissait la commande bloquée à vie,
 *    **même pour un ADMIN**. Les états de préparation et de course peuvent
 *    maintenant être annulés (vendeur jusqu'à `PRET`, ADMIN partout).
 */
export const ORDER_TRANSITION_MATRIX: Record<
  OrderStatus,
  Partial<Record<OrderStatus, OrderActor[]>>
> = {
  EN_ATTENTE: {
    PAYER: ['ADMIN'], // déclenché par le webhook / la confirmation admin
    ANNULER: ['CLIENT', 'RESTAURATEUR', 'ADMIN'],
  },
  PAYER: {
    EN_PREPARATION: ['RESTAURATEUR', 'ADMIN'],
    // Fix H5 : plus de CLIENT ici — l'argent est encaissé, ça passe par le
    // support puis par un remboursement tracé.
    ANNULER: ['RESTAURATEUR', 'ADMIN'],
  },
  EN_PREPARATION: {
    PRET: ['RESTAURATEUR', 'ADMIN'],
    ANNULER: ['RESTAURATEUR', 'ADMIN'], // fix M16 : rupture en cuisine
  },
  PRET: {
    // Le RESTAURATEUR a été retiré d'`EN_ROUTE` (audit post-correction, B-1).
    // Il pouvait déclencher « 🛵 Votre livreur est en chemin ! » par
    // `PATCH /orders/:id/status` alors qu'aucun livreur n'avait rien récupéré
    // — ce qui rouvrait, par une autre porte, la confusion que la séparation
    // `ACCEPTER` / `EN_TRANSIT` venait justement de fermer.
    //
    // Le geste réel du départ est `PATCH /deliveries/:id/pickup`, qui bascule
    // la commande lui-même. L'ADMIN reste listé pour rattraper une course
    // bloquée, mais `OrderLifecycleService` lui impose une `Delivery` en
    // `EN_TRANSIT` : le statut ne peut plus mentir sur le terrain.
    EN_ROUTE: ['LIVREUR', 'ADMIN'],
    // Retrait au comptoir : la commande passe de main à main, elle n'est
    // jamais « en route ». Le vendeur la clôture donc directement, au lieu de
    // traverser `EN_ROUTE` — ce détour était la seule raison pour laquelle il
    // avait besoin de ce statut. `OrderLifecycleService` vérifie
    // `isDelivery === false` : une commande à livrer ne peut pas être déclarée
    // livrée sans qu'un livreur l'ait prise.
    LIVRER: ['RESTAURATEUR', 'ADMIN'],
    ANNULER: ['RESTAURATEUR', 'ADMIN'], // fix M16 : plus aucun livreur
  },
  EN_ROUTE: {
    LIVRER: ['LIVREUR', 'ADMIN'],
    ANNULER: ['ADMIN'], // fix M16 : arbitrage humain uniquement
  },
  LIVRER: {}, // terminal
  ANNULER: {}, // terminal
};

/** Vue « états atteignables », dérivée de la matrice (rétro-compatibilité). */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> =
  Object.fromEntries(
    Object.entries(ORDER_TRANSITION_MATRIX).map(([from, targets]) => [
      from,
      Object.keys(targets) as OrderStatus[],
    ]),
  ) as Record<OrderStatus, OrderStatus[]>;

@Injectable()
export class OrderStateMachine {
  canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return Boolean(ORDER_TRANSITION_MATRIX[from]?.[to]);
  }

  /** L'acteur peut-il faire *cette* transition précise ? */
  canActorTransition(
    from: OrderStatus,
    to: OrderStatus,
    actor: OrderActor,
  ): boolean {
    return ORDER_TRANSITION_MATRIX[from]?.[to]?.includes(actor) ?? false;
  }

  assertTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor): void {
    const allowedActors = ORDER_TRANSITION_MATRIX[from]?.[to];

    if (!allowedActors) {
      const targets = Object.keys(ORDER_TRANSITION_MATRIX[from] ?? {});
      throw new BadRequestException(
        `Transition invalide : ${from} → ${to}. Transitions autorisées depuis ${from} : [${targets.join(', ') || 'aucune'}]`,
      );
    }

    if (!allowedActors.includes(actor)) {
      // 403 et non 400 : la transition existe, c'est l'appelant qui n'a pas le
      // droit de la faire — la distinction compte pour le client mobile, qui
      // affiche un message différent.
      throw new ForbiddenException(
        `L'acteur "${actor}" n'est pas autorisé à passer la commande de "${from}" à "${to}"`,
      );
    }
  }
}
