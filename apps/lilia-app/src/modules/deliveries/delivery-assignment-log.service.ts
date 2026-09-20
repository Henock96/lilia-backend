import { Injectable } from '@nestjs/common';
import { DeliveryAssignmentOutcome, Prisma } from '@prisma/client';

/**
 * Journal des mains par lesquelles une course est passée.
 *
 * ## Ce qu'il ferme
 *
 * `Delivery.delivererId` ne porte que la main **courante**. Une réassignation
 * l'écrasait : plus rien ne disait qui avait été assigné avant, combien de
 * temps, pourquoi il avait été retiré, ni qui l'avait retiré. Le seul indice
 * était le push envoyé à l'ancien livreur — et un push ne se relit pas.
 *
 * ## Une seule ligne ouverte
 *
 * `releasedAt = null` est le discriminant. Toutes les écritures passent par un
 * `updateMany` conditionné dessus, donc elles sont **idempotentes** : fermer
 * deux fois ne fait rien la seconde fois, et une ligne déjà close n'est jamais
 * rouverte. C'est ce qui permet de brancher la clôture sur un listener
 * best-effort (annulation de commande) sans risquer de corrompre le journal.
 *
 * ## `tx` obligatoire
 *
 * Toutes les méthodes prennent le client de transaction. Il n'existe pas de
 * variante hors transaction : un journal qui peut diverger de l'état qu'il
 * décrit ne vaut pas mieux que pas de journal — c'est la règle déjà posée par
 * `OrderTransitionService`.
 */
@Injectable()
export class DeliveryAssignmentLogService {
  /** Ouvre la main d'un livreur sur une course. */
  async open(
    tx: Prisma.TransactionClient,
    params: {
      deliveryId: string;
      orderId: string;
      delivererId: string;
      assignedByUserId: string | null;
      assignedByRole: string;
      assignedAt?: Date;
    },
  ): Promise<void> {
    await tx.deliveryAssignment.create({
      data: {
        deliveryId: params.deliveryId,
        orderId: params.orderId,
        delivererId: params.delivererId,
        assignedByUserId: params.assignedByUserId,
        assignedByRole: params.assignedByRole,
        ...(params.assignedAt ? { assignedAt: params.assignedAt } : {}),
      },
    });
  }

  /**
   * Ferme la main en cours, s'il y en a une.
   *
   * Ne lève jamais quand il n'y a rien à fermer : les courses créées avant
   * cette table n'ont pas de ligne ouverte, et refuser de les clôturer
   * bloquerait une livraison réelle pour un défaut d'historique.
   */
  async close(
    tx: Prisma.TransactionClient,
    deliveryId: string,
    outcome: DeliveryAssignmentOutcome,
    reason?: string | null,
    at: Date = new Date(),
  ): Promise<void> {
    await tx.deliveryAssignment.updateMany({
      where: { deliveryId, releasedAt: null },
      data: { releasedAt: at, outcome, releaseReason: reason?.trim() || null },
    });
  }

  /** Le livreur a répondu — c'est le délai d'acceptation qui devient lisible. */
  async markAccepted(
    tx: Prisma.TransactionClient,
    deliveryId: string,
    at: Date,
  ): Promise<void> {
    await tx.deliveryAssignment.updateMany({
      where: { deliveryId, releasedAt: null },
      data: { acceptedAt: at },
    });
  }

  /** Le livreur a le repas en main. */
  async markPickedUp(
    tx: Prisma.TransactionClient,
    deliveryId: string,
    at: Date,
  ): Promise<void> {
    await tx.deliveryAssignment.updateMany({
      where: { deliveryId, releasedAt: null },
      data: { pickedUpAt: at },
    });
  }

  /**
   * L'historique d'une course, du premier livreur au dernier.
   *
   * ⚠️ **Une table qu'on écrit sans jamais la lire ne prévient de rien.** Si
   * une clôture cessait d'être appelée, ou si une écriture partait hors
   * transaction, rien ne le signalerait — le journal se dégraderait en silence
   * jusqu'au jour où on en aurait besoin, c'est-à-dire pendant un litige. La
   * lecture n'est pas un confort : c'est ce qui rend l'écriture observable.
   *
   * Lecture pure, ordonnée dans le sens du récit (la première main d'abord).
   * `durationSeconds` est **dérivé**, jamais stocké : une durée figée en base
   * se désynchronise de ses bornes à la première correction.
   */
  async history(
    prisma: Prisma.TransactionClient,
    deliveryId: string,
  ): Promise<DeliveryAssignmentRecord[]> {
    const lignes = await prisma.deliveryAssignment.findMany({
      where: { deliveryId },
      orderBy: { assignedAt: 'asc' },
      include: {
        deliverer: { select: { id: true, nom: true, phone: true } },
      },
    });

    return lignes.map((l) => ({
      id: l.id,
      deliverer: l.deliverer,
      assignedAt: l.assignedAt,
      assignedByUserId: l.assignedByUserId,
      assignedByRole: l.assignedByRole,
      acceptedAt: l.acceptedAt,
      pickedUpAt: l.pickedUpAt,
      releasedAt: l.releasedAt,
      outcome: l.outcome,
      releaseReason: l.releaseReason,
      /** Temps passé par ce livreur sur la course. `null` = encore en cours. */
      durationSeconds: l.releasedAt
        ? Math.round((l.releasedAt.getTime() - l.assignedAt.getTime()) / 1000)
        : null,
      /**
       * Délai de réponse du livreur. `null` quand il n'a jamais accepté — ce
       * qui est précisément l'information qu'on cherche sur une course qui a
       * traîné.
       */
      responseSeconds: l.acceptedAt
        ? Math.round((l.acceptedAt.getTime() - l.assignedAt.getTime()) / 1000)
        : null,
    }));
  }
}

/** Une main, telle qu'elle est rendue par l'API. */
export interface DeliveryAssignmentRecord {
  id: string;
  deliverer: { id: string; nom: string | null; phone: string | null };
  assignedAt: Date;
  assignedByUserId: string | null;
  assignedByRole: string;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  releasedAt: Date | null;
  outcome: DeliveryAssignmentOutcome | null;
  releaseReason: string | null;
  durationSeconds: number | null;
  responseSeconds: number | null;
}
