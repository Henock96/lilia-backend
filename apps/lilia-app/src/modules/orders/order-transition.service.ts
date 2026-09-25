import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { acceptanceDeadline } from './order-acceptance-policy';

import {
  DEFAULT_VENDOR_PAYOUT_DELAY_MINUTES,
  DeliveryProof,
  OrderTransitionActor,
  OrderTransitionSource,
  payoutDueAtFor,
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

    const deadline =
      to === OrderStatus.PAYER
        ? await this.acceptanceDeadlineFor(tx, orderId, data)
        : null;
    const delivered =
      to === OrderStatus.LIVRER
        ? await this.deliveryProofData(tx, params.proof)
        : null;

    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: from },
      data: {
        status: to,
        ...(data ?? {}),
        ...(deadline ? { acceptDeadlineAt: deadline } : {}),
        ...(delivered ?? {}),
      },
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
    params: Omit<OrderTransitionBase, 'from'> & { to: OrderStatus },
  ): Promise<void> {
    await this.writeHistory(tx, { ...params, from: null });
  }

  /**
   * Échéance d'acceptation vendeur, posée au passage à `PAYER` (F3-01).
   *
   * Ici et pas aux sites de paiement : c'est le seul point par lequel TOUT
   * chemin vers `PAYER` passe (encaissement, règlement en points, confirmation
   * manuelle, et ceux qui viendront). Calculée AVANT le `updateMany` pour être
   * écrite dans la même requête que le statut.
   *
   * Aucune échéance tant que `orderAcceptanceRequired` est faux : sinon, au
   * moment de l'allumer, toutes les commandes restées `PAYER` depuis plus de
   * huit minutes expireraient d'un coup.
   */
  private async acceptanceDeadlineFor(
    tx: Prisma.TransactionClient,
    orderId: string,
    data: OrderTransitionParams['data'],
  ): Promise<Date | null> {
    const settings = await tx.platformSettings.findUnique({
      where: { id: 'singleton' },
      select: {
        orderAcceptanceRequired: true,
        vendorAcceptanceTimeoutMinutes: true,
        preorderAcceptanceHours: true,
      },
    });
    if (!settings?.orderAcceptanceRequired) return null;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        isPreorder: true,
        scheduledFor: true,
        restaurant: { select: { preorderLeadHours: true } },
      },
    });
    if (!order) return null;

    const paidAt = data?.paidAt instanceof Date ? data.paidAt : new Date();
    return acceptanceDeadline(
      {
        paidAt,
        isPreorder: order.isPreorder,
        scheduledFor: order.scheduledFor,
        preorderLeadHours: order.restaurant.preorderLeadHours,
      },
      settings,
    );
  }

  /**
   * Retrait : le client confirme après que le vendeur a déclaré la remise seul
   * (F3-07, D-P1). La commande est déjà `LIVRER` — aucune transition, donc
   * aucune ligne d'historique (une ligne `LIVRER → LIVRER` fausserait les
   * durées par étape) : `customerConfirmedAt` date la confirmation.
   *
   * La preuve ne fait que **monter** (I-9) et l'échéance ne s'écrit qu'une fois
   * (I-10) : l'écriture est conditionnée sur `PICKUP_VENDOR_DECLARED`. Deux
   * confirmations simultanées : la seconde affecte 0 ligne.
   *
   * @returns `true` si CET appel a monté la preuve.
   */
  async upgradeToCustomerConfirmed(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<boolean> {
    const proved = await this.deliveryProofData(
      tx,
      'PICKUP_CUSTOMER_CONFIRMED',
    );
    const claimed = await tx.order.updateMany({
      where: {
        id: orderId,
        status: OrderStatus.LIVRER,
        isDelivery: false,
        deliveryProof: 'PICKUP_VENDOR_DECLARED',
      },
      data: {
        deliveryProof: proved.deliveryProof,
        customerConfirmedAt: proved.customerConfirmedAt,
        payoutDueAt: proved.payoutDueAt,
      },
    });
    if (claimed.count === 0) return false;
    this.logger.log(
      `📓 [PREUVE] ${orderId} PICKUP_VENDOR_DECLARED → PICKUP_CUSTOMER_CONFIRMED`,
    );
    return true;
  }

  /**
   * Colonnes écrites avec `LIVRER` (F3-07) : date, preuve, échéance de
   * versement. Une transition vers `LIVRER` sans preuve est une erreur de
   * programmation — elle lève avant toute écriture, plutôt que de livrer une
   * commande dont personne ne saurait dire si le vendeur peut être payé.
   */
  private async deliveryProofData(
    tx: Prisma.TransactionClient,
    proof: DeliveryProof | undefined,
  ): Promise<{
    deliveredAt: Date;
    deliveryProof: DeliveryProof;
    customerConfirmedAt: Date | null;
    payoutDueAt: Date | null;
  }> {
    if (!proof) {
      throw new Error(
        'Transition vers LIVRER sans preuve de remise : chaque chemin doit dire comment la remise est attestée.',
      );
    }
    const settings = await tx.platformSettings.findUnique({
      where: { id: 'singleton' },
      select: { vendorPayoutDelayMinutes: true },
    });
    const now = new Date();
    return {
      deliveredAt: now,
      deliveryProof: proof,
      customerConfirmedAt: proof === 'PICKUP_CUSTOMER_CONFIRMED' ? now : null,
      payoutDueAt: payoutDueAtFor(
        proof,
        now,
        settings?.vendorPayoutDelayMinutes ??
          DEFAULT_VENDOR_PAYOUT_DELAY_MINUTES,
      ),
    };
  }

  private async writeHistory(
    tx: Prisma.TransactionClient,
    params: Omit<OrderTransitionBase, 'from'> & {
      from: OrderStatus | null;
      to: OrderStatus;
    },
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

/**
 * Paramètres d'une transition. Vers `LIVRER`, la preuve de remise est
 * **obligatoire** (F3-07) : un appelant qui l'oublie ne compile pas.
 */
export type OrderTransitionParams = OrderTransitionBase &
  (
    | { to: typeof OrderStatus.LIVRER; proof: DeliveryProof }
    | { to: Exclude<OrderStatus, typeof OrderStatus.LIVRER>; proof?: never }
  );

interface OrderTransitionBase {
  orderId: string;
  /**
   * État attendu. La transition n'est appliquée que si la commande y est
   * toujours — c'est le verrou optimiste, et il est la seule protection contre
   * deux acteurs qui font avancer la même commande à la même seconde.
   */
  from: OrderStatus;
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
