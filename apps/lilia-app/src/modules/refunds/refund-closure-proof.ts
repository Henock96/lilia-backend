import { BadRequestException } from '@nestjs/common';

/**
 * Preuve de clôture d'un remboursement (audit du 28/10/2026, F-12).
 *
 * `PATCH /refunds/:id/status` passait un remboursement `COMPLETED` sur la
 * seule parole d'un administrateur — `notes` facultatif, aucune référence.
 * « L'argent est revenu au client » est pourtant l'affirmation la plus
 * sensible de la file. Une clôture déclarée exige désormais la même pièce que
 * `DriverSettlement` : une méthode, une référence opposable, une date.
 *
 * Liste miroir du CHECK `Refund_closureMethod_known` (règle 14 : `TEXT` +
 * CHECK, pas d'enum PostgreSQL pour un vocabulaire évolutif).
 */
export const REFUND_CLOSURE_METHODS = [
  'PROVIDER',
  'MOBILE_MONEY_MANUAL',
  'CASH',
  'BANK_TRANSFER',
  'OTHER',
] as const;
export type RefundClosureMethod = (typeof REFUND_CLOSURE_METHODS)[number];

/** Méthodes qu'un administrateur peut déclarer (jamais `PROVIDER`). */
export const DECLARED_CLOSURE_METHODS = REFUND_CLOSURE_METHODS.filter(
  (m) => m !== 'PROVIDER',
) as Exclude<RefundClosureMethod, 'PROVIDER'>[];

export interface RefundClosureProof {
  method: Exclude<RefundClosureMethod, 'PROVIDER'>;
  externalReference: string;
  paidAt: Date;
}

/** Longueur minimale d'une référence — miroir du CHECK SQL. */
export const MIN_REFERENCE_LENGTH = 4;

/**
 * Valide la preuve d'une clôture déclarée. Lève un 400 explicite, avec un
 * `code` lisible par les back-offices.
 */
export function assertDeclaredClosureProof(
  proof:
    | Partial<{
        method: string;
        externalReference: string;
        paidAt: Date | string;
      }>
    | undefined,
  now = new Date(),
): RefundClosureProof {
  const method = proof?.method;
  const reference = proof?.externalReference?.trim();
  const paidAt = proof?.paidAt ? new Date(proof.paidAt) : undefined;

  const missing: string[] = [];
  if (!method || !(DECLARED_CLOSURE_METHODS as string[]).includes(method)) {
    missing.push('méthode (Mobile Money manuel, espèces, virement, autre)');
  }
  if (!reference || reference.length < MIN_REFERENCE_LENGTH) {
    missing.push(
      `référence de l'opération (au moins ${MIN_REFERENCE_LENGTH} caractères)`,
    );
  }
  if (!paidAt || Number.isNaN(paidAt.getTime())) {
    missing.push('date du remboursement');
  } else if (paidAt.getTime() > now.getTime() + 5 * 60_000) {
    missing.push('date du remboursement (elle ne peut pas être dans le futur)');
  }

  if (missing.length > 0) {
    throw new BadRequestException({
      message:
        'Un remboursement ne peut être déclaré effectué sans preuve : ' +
        missing.join(', ') +
        '. Seul un remboursement confirmé par le prestataire s’en passe.',
      code: 'REFUND_PROOF_REQUIRED',
    });
  }
  return {
    method: method as RefundClosureProof['method'],
    externalReference: reference!,
    paidAt: paidAt!,
  };
}

/**
 * Niveau de preuve d'un remboursement, pour l'affichage d'administration :
 *  - `PROVIDER_CONFIRMED` : le prestataire a confirmé le virement ;
 *  - `DECLARED` : un administrateur a déclaré un remboursement hors
 *    prestataire, avec référence et date ;
 *  - `UNQUALIFIED` : clôture historique (avant F-12), sans preuve enregistrée ;
 *  - `IN_PROGRESS` : virement chez le prestataire, issue non connue ;
 *  - `OPEN` / `REJECTED` : pas (ou pas encore) de remboursement.
 */
export type RefundProofLevel =
  | 'PROVIDER_CONFIRMED'
  | 'DECLARED'
  | 'UNQUALIFIED'
  | 'IN_PROGRESS'
  | 'OPEN'
  | 'REJECTED';

export function refundProofLevel(refund: {
  status: string;
  closureMethod: string | null;
}): RefundProofLevel {
  switch (refund.status) {
    case 'COMPLETED':
      if (refund.closureMethod === 'PROVIDER') return 'PROVIDER_CONFIRMED';
      if (refund.closureMethod) return 'DECLARED';
      return 'UNQUALIFIED';
    case 'PROCESSING':
      return 'IN_PROGRESS';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'OPEN';
  }
}
