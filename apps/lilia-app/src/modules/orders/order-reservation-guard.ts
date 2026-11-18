import { ConflictException } from '@nestjs/common';

export const ORDER_MANAGED_BY_RESERVATION = 'ORDER_MANAGED_BY_RESERVATION';

/**
 * Lot 4 (4B-2, OD-20) — la commande liée à une réservation (précommande
 * payée à la réservation) ne se pilote pas par les routes de commande pour
 * l'annuler ou la clore : la réservation porte la table, l'échéance et le
 * remboursement. Sinon une réservation `CONFIRMED` survivrait à sa commande
 * annulée, ou un versement s'ouvrirait sans passage du client.
 *
 * Fermés pour tout rôle (relevé du 21/10 : les annulations administratives
 * passent par le parcours réservation) : annulation client, refus et statut
 * `ANNULER` du restaurant, « j'ai récupéré » du client, statut `LIVRER`
 * (arbitrage compris). Restent ouverts : la préparation (`EN_PREPARATION`,
 * `PRET`) et la remise par code (`pickup/handover`).
 */
export function assertNotManagedByReservation(order: {
  reservationId?: string | null;
}): void {
  if (!order.reservationId) return;
  throw new ConflictException({
    message:
      'Cette commande est la précommande d’une réservation : annulez ou concluez la réservation, pas la commande.',
    code: ORDER_MANAGED_BY_RESERVATION,
  });
}
