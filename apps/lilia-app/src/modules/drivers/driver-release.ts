import {
  DeliveryStatus,
  DriverStatus,
  IncidentStatus,
  Prisma,
  StatusUser,
} from '@prisma/client';

import { USER_BAN_APPLIED_EVENT } from '../outbox/outbox-events';
import { lockDriverRow } from './driver-row-lock';

/** Ce que la libération a décidé — utile aux journaux et aux tests. */
export type DriverReleaseResult =
  /** Plus aucune course : `ON_DELIVERY → AVAILABLE` (ou `OFFLINE`, compte révoqué). */
  | 'released'
  /** Il porte encore une course acceptée : il reste `ON_DELIVERY`. */
  | 'kept_busy'
  /** Il n'était pas `ON_DELIVERY` (hors ligne, disponible, inconnu) : rien. */
  | 'kept_status'
  /**
   * F3-12.1 R7 — sa dernière course est close et un ban l'attendait : il est
   * appliqué ici (`BLOCKED`, `OFFLINE`), la coupure Firebase part par l'outbox.
   */
  | 'banned';

/**
 * Courses qui OCCUPENT un livreur au sens de `ON_DELIVERY`.
 *
 * `ASSIGNER` n'en fait pas partie, et c'est voulu : une mission confiée mais
 * pas acceptée ne pose jamais `ON_DELIVERY` (seul `acceptDelivery` le fait).
 * C'est aussi pourquoi le refus d'une mission `ASSIGNER` ne libère plus rien.
 */
const HOLDING_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ACCEPTER,
  DeliveryStatus.EN_TRANSIT,
];

/**
 * **Seul point de libération d'un livreur** (F3-12.1, gate R5).
 *
 * Invariant : `ON_DELIVERY` ⇔ le livreur porte une course `ACCEPTER` ou
 * `EN_TRANSIT`.
 *
 * ## Le défaut corrigé
 *
 * Cinq chemins repassaient le livreur `AVAILABLE` à la fin d'UNE course, sans
 * regarder s'il en portait une autre : le listener (réassignation, refus,
 * échec, annulation — best-effort, hors transaction), `updateStatus`
 * (`update` inconditionnel), et la déclaration d'échec F3-05. Or l'assignation
 * empilée est permise : un livreur en course reste assignable. Refuser,
 * échouer, réassigner ou annuler la SECONDE course le rendait disponible en
 * pleine première course — prouvé sur PostgreSQL réel, sans aucune
 * concurrence (`driver-release.int-spec.ts`).
 *
 * ## Contrat
 *
 * - À appeler **dans la transaction** qui clôt ou retire la course, APRÈS son
 *   écriture : la course fermée n'est plus comptée, puisque la lecture voit
 *   les écritures de sa propre transaction.
 * - Rang R4 de l'ordre global des verrous (`lockDriverRow`) : l'appelant a
 *   déjà pris `Order`/`Delivery` s'il en a besoin, et ne prend plus rien de
 *   rang inférieur ensuite.
 * - La décision est prise sous le verrou du livreur, celui que prennent aussi
 *   l'acceptation, la disponibilité et la désactivation : l'une attend
 *   l'autre, et la seconde relit un état à jour.
 * - Un compte qui n'est plus `ACTIVE` ou plus `LIVREUR` repasse `OFFLINE`,
 *   jamais `AVAILABLE` : une clôture ne réactive pas un compte révoqué.
 * - **Ban différé (R7, Q3/Q7)** : un ban demandé pendant une course est
 *   appliqué ici, à la clôture de la DERNIÈRE course tenue, dans la même
 *   transaction. C'est le seul point d'application : toutes les clôtures
 *   (livraison, échec, réassignation, annulation) passent par ce helper.
 */
export async function releaseDriverIfIdle(
  tx: Prisma.TransactionClient,
  driverId: string,
): Promise<DriverReleaseResult> {
  const driver = await lockDriverRow(tx, driverId);
  if (!driver) return 'kept_status';

  const holdingCount = () =>
    tx.delivery.count({
      where: { delivererId: driverId, status: { in: HOLDING_STATUSES } },
    });

  if (driver.banPendingAt) {
    if ((await holdingCount()) > 0) return 'kept_busy';
    await applyPendingBan(tx, driverId);
    return 'banned';
  }

  if (driver.driverStatus !== DriverStatus.ON_DELIVERY) return 'kept_status';

  const holding = await holdingCount();
  if (holding > 0) return 'kept_busy';

  const eligible = driver.statusUser === 'ACTIVE' && driver.role === 'LIVREUR';
  // CAS sur l'état lu sous verrou : redondant tant que le verrou tient, c'est
  // la ceinture si quelqu'un retire un jour la ligne du dessus.
  await tx.user.updateMany({
    where: { id: driverId, driverStatus: DriverStatus.ON_DELIVERY },
    data: {
      driverStatus: eligible ? DriverStatus.AVAILABLE : DriverStatus.OFFLINE,
    },
  });
  return 'released';
}

/**
 * Applique un ban différé : `BLOCKED` + `OFFLINE`, drapeau effacé, dans une
 * seule écriture — le CHECK `User_ban_pending_consistent` interdit l'état
 * intermédiaire. Sous le verrou R4 de l'appelant.
 *
 * Firebase et le cache Redis ne sont pas transactionnels : leur coupure est
 * une OBLIGATION écrite ici (outbox) et exécutée après le commit, y compris
 * quand la clôture vient du worker. D'ici là, la base refuse déjà tout geste
 * sensible (acceptation, assignation, offre) : ils relisent `statusUser` sous
 * ce même verrou.
 */
async function applyPendingBan(
  tx: Prisma.TransactionClient,
  driverId: string,
): Promise<void> {
  await tx.user.update({
    where: { id: driverId },
    data: {
      statusUser: StatusUser.BLOCKED,
      driverStatus: DriverStatus.OFFLINE,
      banPendingAt: null,
      banPendingReason: null,
      banPendingById: null,
    },
  });
  await tx.outboxEvent.create({
    data: {
      type: USER_BAN_APPLIED_EVENT,
      aggregateId: driverId,
      payload: { userId: driverId },
    },
  });
  // L'incident ouvert à la demande du ban n'a plus d'objet : sa cause (un
  // banni encore en course) a disparu.
  await tx.incident.updateMany({
    where: {
      dedupKey: banPendingIncidentKey(driverId),
      status: { in: [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS] },
    },
    data: {
      status: IncidentStatus.RESOLVED,
      autoResolved: true,
      resolution: 'Course terminée : bannissement appliqué.',
    },
  });
}

/** Une demande de ban différé = un incident ouvert au plus (index partiel). */
export function banPendingIncidentKey(driverId: string): string {
  return `ban_pending:${driverId}`;
}
