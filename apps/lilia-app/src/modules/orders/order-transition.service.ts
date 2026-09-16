import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';

import {
  OrderTransitionActor,
  OrderTransitionSource,
} from './order-transition.types';

/**
 * Le **seul** endroit où `Order.status` change.
 *
 * ## Le problème qu'il ferme
 *
 * Sept sites répartis dans quatre fichiers écrivaient le statut d'une commande :
 * le checkout, trois chemins de `OrderLifecycleService`, deux de
 * `PaymentService`, deux de `deliveries/`. Six posaient un verrou optimiste
 * correct, le septième le posait et **jetait son résultat**
 * (`deliveries.service.ts`, corrigé avec ce chantier). Et aucun n'écrivait dans
 * `OrderHistory` — table présente depuis avril 2026, vide depuis avril 2026.
 *
 * La conséquence n'était pas seulement documentaire : sans horodatage de
 * transition, on sait qu'une commande a mis 74 minutes, jamais **où** elles sont
 * passées. Ni le délai d'acceptation vendeur, ni le temps de préparation, ni
 * l'attente d'un livreur n'étaient calculables.
 *
 * ## Ce que ce service garantit
 *
 * 1. **Atomicité.** Le changement de statut et sa ligne d'historique sont
 *    écrits dans la même transaction. Il ne peut pas exister de commande en
 *    `PRET` sans ligne `PRET`. `tx` est un paramètre **obligatoire** : il n'y a
 *    pas de variante hors transaction, donc pas de moyen de contourner la règle
 *    par inadvertance.
 * 2. **Concurrence.** Le verrou optimiste existant est repris à l'identique —
 *    `updateMany WHERE status = <état lu>` — et son résultat est, lui,
 *    toujours vérifié. Zéro ligne affectée ⇒ personne n'écrit d'historique.
 * 3. **Traçabilité.** Acteur (rôle **et** identifiant), provenance, motif.
 *
 * ## Pourquoi deux méthodes
 *
 * Six sites veulent qu'une transition perdue soit une **erreur** : le vendeur
 * ou le livreur doit recharger. Les deux sites de paiement veulent l'inverse :
 * un encaissement qui aboutit sur une commande déjà expirée n'est pas une
 * erreur HTTP, c'est un litige à tracer sans rien forcer (`payment.orphan`).
 * Les servir avec une seule méthode obligerait l'un des deux camps à rattraper
 * une exception pour l'ignorer — c'est-à-dire à écrire le bug de demain.
 */
@Injectable()
export class OrderTransitionService {
  private readonly logger = new Logger(OrderTransitionService.name);

  /**
   * Fait avancer une commande, ou **échoue en 409**.
   *
   * @throws ConflictException si la commande n'est plus dans `from`.
   */
  async transition(
    tx: Prisma.TransactionClient,
    params: OrderTransitionParams,
  ): Promise<void> {
    const { moved } = await this.tryTransition(tx, params);
    if (!moved) {
      // Message repris mot pour mot de `OrderLifecycleService.claimStatus` :
      // les applications l'affichent tel quel, et trois d'entre elles sont
      // déjà déployées.
      throw new ConflictException(
        'Le statut de cette commande a changé entre-temps. Rechargez-la avant de réessayer.',
      );
    }
  }

  /**
   * Fait avancer une commande, ou rend `{ moved: false }` **sans lever**.
   *
   * Réservé aux chemins qui doivent traiter l'échec autrement qu'en erreur —
   * aujourd'hui la confirmation d'encaissement, qui ouvre un incident plutôt
   * que de forcer une transition.
   */
  async tryTransition(
    tx: Prisma.TransactionClient,
    params: OrderTransitionParams,
  ): Promise<{ moved: boolean }> {
    const { orderId, from, to, data } = params;

    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to, ...(data ?? {}) },
    });

    if (claimed.count === 0) return { moved: false };

    await this.writeHistory(tx, { ...params, from });
    return { moved: true };
  }

  /**
   * Ouvre l'historique d'une commande qui vient d'être créée.
   *
   * Séparé de `transition` parce qu'il n'y a **rien à revendiquer** : la ligne
   * vient d'être insérée dans la même transaction, personne d'autre ne la
   * connaît encore. Un `updateMany` conditionnel y serait une écriture inutile
   * et, surtout, trompeuse — il suggérerait une concurrence qui n'existe pas.
   *
   * `fromStatus` vaut `null` : il n'y a pas d'état de départ, et l'écrire
   * `EN_ATTENTE → EN_ATTENTE` ferait compter la création comme une transition
   * dans toute agrégation de durée par étape.
   */
  async recordCreation(
    tx: Prisma.TransactionClient,
    params: Omit<OrderTransitionParams, 'from'>,
  ): Promise<void> {
    await this.writeHistory(tx, { ...params, from: null });
  }

  private async writeHistory(
    tx: Prisma.TransactionClient,
    params: OrderTransitionParams & { from: OrderStatus | null },
  ): Promise<void> {
    const { orderId, from, to, actor, actorUserId, source, reason } = params;

    await tx.orderHistory.create({
      data: {
        orderId,
        fromStatus: from,
        toStatus: to,
        // `actionId` porte le rôle — nom historique conservé, aucun
        // consommateur ne le lit (la table n'a jamais été écrite).
        actionId: actor,
        actorUserId: actorUserId ?? null,
        source,
        reason: reason ?? null,
      },
    });

    this.logger.log(
      `📓 [HISTORIQUE] ${orderId} ${from ?? '∅'} → ${to} ` +
        `(${actor}${actorUserId ? `/${actorUserId}` : ''}, ${source})`,
    );
  }
}

export interface OrderTransitionParams {
  orderId: string;
  /**
   * État attendu. La transition n'est appliquée que si la commande y est
   * toujours — c'est le verrou optimiste, et il est la seule protection contre
   * deux acteurs qui font avancer la même commande à la même seconde.
   */
  from: OrderStatus;
  to: OrderStatus;
  actor: OrderTransitionActor;
  /** `User.id` de l'auteur. `null` pour une transition automatique. */
  actorUserId?: string | null;
  source: OrderTransitionSource;
  reason?: string | null;
  /**
   * Champs écrits **avec** le statut, dans le même `updateMany`.
   *
   * Sert aujourd'hui à `paidAt`, qui doit être posé exactement quand la
   * commande passe `PAYER` — l'écrire dans une seconde requête rouvrirait la
   * fenêtre que le verrou ferme.
   */
  data?: Prisma.OrderUpdateManyMutationInput;
}
