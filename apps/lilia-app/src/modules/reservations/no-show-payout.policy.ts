import { ConflictException } from '@nestjs/common';
import { PayoutProvider } from '@prisma/client';

import { payoutAccountCoolingUntil } from '../payments/services/restaurant-payout.service';

/**
 * 4B-2 J6b — règles pures du versement de la part restaurant d'une absence
 * (`16-J6b-design.md`).
 */

/** Liste miroir du CHECK `ReservationNoShowPayout_status_check` (règle 14). */
export const NO_SHOW_PAYOUT_STATUSES = [
  'PENDING',
  'SUCCESS',
  'FAILED',
] as const;
export type NoShowPayoutStatus = (typeof NO_SHOW_PAYOUT_STATUSES)[number];

/** Statuts qui occupent l'absence (index unique partiel). */
export const ACTIVE_NO_SHOW_PAYOUT_STATUSES: NoShowPayoutStatus[] = [
  'PENDING',
  'SUCCESS',
];

/** Ce qu'une approbation autorise : CETTE part, vers CE numéro, CET opérateur. */
export interface NoShowPayoutApprovalPayload {
  settlementId: string;
  amountXaf: number;
  phoneNumber: string;
  payoutProvider: PayoutProvider;
}

export interface NoShowPayoutAccount {
  payoutPhoneNumber: string | null;
  payoutProvider: PayoutProvider | null;
  payoutVerifiedAt: Date | null;
}

/**
 * Le compte de versement peut-il recevoir la part (P-2) ? Vérifié à la
 * demande ET à la validation.
 *
 * Plus strict que le reversement d'une commande : un compte jamais vérifié
 * par un administrateur (`payoutVerifiedAt` nul, antérieur au dispositif)
 * est refusé — la part d'une absence part sur décision humaine, pas sur une
 * preuve de livraison.
 */
export function assertNoShowPayoutAccountUsable(
  account: NoShowPayoutAccount,
  now: Date,
  accountChangePending: boolean,
): asserts account is NoShowPayoutAccount & {
  payoutPhoneNumber: string;
  payoutProvider: PayoutProvider;
} {
  if (!account.payoutPhoneNumber || !account.payoutProvider) {
    throw new ConflictException({
      message:
        'Ce restaurant n’a aucun compte Mobile Money de versement. Renseignez-le dans sa fiche.',
      code: 'NO_SHOW_PAYOUT_ACCOUNT_MISSING',
    });
  }
  if (!account.payoutVerifiedAt) {
    throw new ConflictException({
      message:
        'Le compte de versement de ce restaurant n’a jamais été vérifié par un administrateur. Vérifiez-le avant de verser.',
      code: 'NO_SHOW_PAYOUT_ACCOUNT_UNVERIFIED',
    });
  }
  const coolingUntil = payoutAccountCoolingUntil(account.payoutVerifiedAt, now);
  if (coolingUntil) {
    throw new ConflictException({
      message:
        'Le compte de versement de ce restaurant vient d’être modifié. Par sécurité, ' +
        `aucun virement n’y part avant le ${coolingUntil.toLocaleString('fr-FR', { timeZone: 'Africa/Brazzaville' })}.`,
      code: 'VENDOR_PAYOUT_ACCOUNT_COOLING_DOWN',
    });
  }
  if (accountChangePending) {
    throw new ConflictException({
      message:
        'Un changement du compte de versement de ce restaurant attend une approbation. Traitez-le avant de verser.',
      code: 'NO_SHOW_PAYOUT_ACCOUNT_CHANGE_PENDING',
    });
  }
}

export function noShowPayoutApprovalPayload(
  settlement: { id: string; vendorShareXaf: number },
  account: { payoutPhoneNumber: string; payoutProvider: PayoutProvider },
): NoShowPayoutApprovalPayload {
  return {
    settlementId: settlement.id,
    amountXaf: settlement.vendorShareXaf,
    phoneNumber: account.payoutPhoneNumber,
    payoutProvider: account.payoutProvider,
  };
}

export function sameNoShowPayoutPayload(
  a: NoShowPayoutApprovalPayload,
  b: NoShowPayoutApprovalPayload,
): boolean {
  return (
    a.settlementId === b.settlementId &&
    a.amountXaf === b.amountXaf &&
    a.phoneNumber === b.phoneNumber &&
    a.payoutProvider === b.payoutProvider
  );
}

/** État d'une absence pour le back-office (B-3). */
export type NoShowPayoutState = 'NOTHING_DUE' | 'DUE' | 'IN_PROGRESS' | 'PAID';

export function noShowPayoutState(
  vendorShareXaf: number,
  statuses: string[],
): NoShowPayoutState {
  if (vendorShareXaf <= 0) return 'NOTHING_DUE';
  if (statuses.includes('SUCCESS')) return 'PAID';
  if (statuses.includes('PENDING')) return 'IN_PROGRESS';
  return 'DUE';
}
