/**
 * Échéance d'acceptation d'une commande payée (Phase 3, F3-01).
 *
 * Au-delà, une commande restée `PAYER` est annulée et remboursée : c'est ce
 * qui garantit qu'aucun client débité n'attend une réponse qui ne viendra
 * jamais. Fonction pure, appelée par le point d'écriture unique du statut
 * (`OrderTransitionService`) au passage à `PAYER` — tout chemin de paiement,
 * présent ou futur, reçoit donc son échéance sans avoir à y penser.
 *
 * L'échéance est **figée** sur la commande : changer le délai plateforme ne
 * réécrit pas les commandes en cours.
 */
export interface AcceptanceDeadlineInput {
  paidAt: Date;
  isPreorder: boolean;
  scheduledFor: Date | null;
  /** Délai de préparation annoncé par le vendeur pour ses précommandes. */
  preorderLeadHours: number | null;
}

export interface AcceptanceDeadlineSettings {
  vendorAcceptanceTimeoutMinutes: number;
  preorderAcceptanceHours: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function acceptanceDeadline(
  input: AcceptanceDeadlineInput,
  settings: AcceptanceDeadlineSettings,
): Date {
  const paid = input.paidAt.getTime();
  // Plancher : même une précommande mal datée laisse au vendeur le délai d'une
  // commande immédiate — on ne crée pas une commande qui expire au paiement.
  const floor = paid + settings.vendorAcceptanceTimeoutMinutes * MINUTE_MS;

  if (!input.isPreorder) return new Date(floor);

  // Une précommande laisse plus de temps, mais le vendeur doit avoir répondu
  // avant de devoir commencer : heure de livraison moins sa préparation.
  let deadline = paid + settings.preorderAcceptanceHours * HOUR_MS;
  if (input.scheduledFor) {
    const mustStartBy =
      input.scheduledFor.getTime() - (input.preorderLeadHours ?? 0) * HOUR_MS;
    deadline = Math.min(deadline, mustStartBy);
  }
  return new Date(Math.max(deadline, floor));
}
