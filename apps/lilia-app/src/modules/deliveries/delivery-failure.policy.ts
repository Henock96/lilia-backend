import { DeliveryFailureReason, FailureLiability } from '@prisma/client';

/**
 * Échec de livraison (F3-05) — règles d'argent et de preuve, pures.
 *
 * Le responsable d'un échec décide de trois mouvements d'argent, jamais
 * de « l'humeur de l'arbitrage » (R-05.3) :
 *
 * | Responsable | Client       | Vendeur  | Livreur  |
 * |-------------|--------------|----------|----------|
 * | CLIENT      | non remboursé (D10, 24/09/2026) | payé | payé |
 * | DRIVER      | remboursé    | payé     | non payé |
 * | VENDOR      | remboursé    | non payé | payé     |
 * | PLATFORM    | remboursé    | payé     | payé     |
 *
 * Le stock n'est jamais rendu : le repas a quitté la cuisine.
 */
export interface FailureOutcome {
  refundClient: boolean;
  payVendor: boolean;
  payDriver: boolean;
}

export const FAILURE_OUTCOMES: Record<FailureLiability, FailureOutcome> = {
  CLIENT: { refundClient: false, payVendor: true, payDriver: true },
  DRIVER: { refundClient: true, payVendor: true, payDriver: false },
  VENDOR: { refundClient: true, payVendor: false, payDriver: true },
  PLATFORM: { refundClient: true, payVendor: true, payDriver: true },
};

/** Protocole « client injoignable » (R-05.4). Valeurs de travail (ASSUMED). */
export const UNREACHABLE_PROTOCOL = {
  minCallAttempts: 2,
  minWaitMinutes: 10,
  maxDistanceM: 300,
} as const;

export interface FailureEvidence {
  reason: DeliveryFailureReason | null;
  callAttempts: number;
  smsSentAt: Date | null;
  protocolStartedAt: Date | null;
  declaredAt: Date | null;
  distanceToDestM: number | null;
}

/**
 * Le client peut-il être tenu pour responsable ? Renvoie ce qui manque à la
 * preuve, en français — vide = oui.
 *
 *  - Refus à la porte : oui, le livreur était là et le client a refusé.
 *  - Injoignable : seulement si le protocole est complet et prouvé ; sinon la
 *    plateforme assume (D10).
 *  - Tout autre motif (adresse introuvable, accident, perte…) : non. Une
 *    adresse introuvable à Brazzaville est d'abord un problème de géocodage.
 */
export function clientLiabilityGaps(
  evidence: FailureEvidence,
  destinationExact: boolean,
): string[] {
  if (evidence.reason === 'CUSTOMER_REFUSED') return [];
  if (evidence.reason !== 'CUSTOMER_UNREACHABLE') {
    return [
      'Seuls un refus du client ou un client injoignable (protocole complet) engagent le client.',
    ];
  }

  const gaps: string[] = [];
  const p = UNREACHABLE_PROTOCOL;
  if (evidence.callAttempts < p.minCallAttempts) {
    gaps.push(
      `${p.minCallAttempts} appels au moins (${evidence.callAttempts} journalisé(s)).`,
    );
  }
  if (!evidence.smsSentAt) gaps.push('Aucun SMS parti au client.');
  if (!evidence.protocolStartedAt || !evidence.declaredAt) {
    gaps.push('Protocole jamais démarré.');
  } else if (
    evidence.declaredAt.getTime() - evidence.protocolStartedAt.getTime() <
    p.minWaitMinutes * 60_000
  ) {
    gaps.push(`${p.minWaitMinutes} minutes d'attente au moins.`);
  }
  // La distance ne prouve quelque chose que si la destination est un point
  // réel : mesurée à un centroïde de quartier, elle ne dit rien de la porte.
  if (destinationExact) {
    if (evidence.distanceToDestM == null) {
      gaps.push('Position du livreur inconnue à la déclaration.');
    } else if (evidence.distanceToDestM > p.maxDistanceM) {
      gaps.push(
        `Livreur à ${evidence.distanceToDestM} m de l'adresse (${p.maxDistanceM} m au plus).`,
      );
    }
  }
  return gaps;
}

/** Délai restant avant que « Déclarer l'échec » soit permis, en secondes. */
export function protocolWaitRemainingSeconds(
  protocolStartedAt: Date | null,
  now: Date,
): number | null {
  if (!protocolStartedAt) return null;
  const end =
    protocolStartedAt.getTime() + UNREACHABLE_PROTOCOL.minWaitMinutes * 60_000;
  return Math.max(0, Math.ceil((end - now.getTime()) / 1000));
}
