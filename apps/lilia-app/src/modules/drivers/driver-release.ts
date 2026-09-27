import { DeliveryStatus, DriverStatus, Prisma } from '@prisma/client';

import { lockDriverRow } from './driver-row-lock';

/** Ce que la libération a décidé — utile aux journaux et aux tests. */
export type DriverReleaseResult =
  /** Plus aucune course : `ON_DELIVERY → AVAILABLE` (ou `OFFLINE`, compte révoqué). */
  | 'released'
  /** Il porte encore une course acceptée : il reste `ON_DELIVERY`. */
  | 'kept_busy'
  /** Il n'était pas `ON_DELIVERY` (hors ligne, disponible, inconnu) : rien. */
  | 'kept_status';

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
 */
export async function releaseDriverIfIdle(
  tx: Prisma.TransactionClient,
  driverId: string,
): Promise<DriverReleaseResult> {
  const driver = await lockDriverRow(tx, driverId);
  if (!driver || driver.driverStatus !== DriverStatus.ON_DELIVERY) {
    return 'kept_status';
  }

  const holding = await tx.delivery.count({
    where: { delivererId: driverId, status: { in: HOLDING_STATUSES } },
  });
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
