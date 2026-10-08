import { RefundStatus } from '@prisma/client';

import { REFUND_APPROVAL_THRESHOLD_XAF } from '../approvals/approval-rules';

/**
 * Quand un remboursement exige un second administrateur (F3-08 / D7, R-01).
 *
 * Un seul seuil, deux prédicats — un par nature de geste — lus par les trois
 * chemins qui soldent une dette client :
 *  - le virement (`executionNeedsApproval` : `RefundExecutionService.execute`,
 *    `POST /refunds/:id/execute`, et le compositeur `POST /admin/orders/:id/refunds`) ;
 *  - la clôture déclarative (`closureNeedsApproval` : `RefundsService.updateStatus`,
 *    `PATCH /refunds/:id/status`).
 *
 * Le chemin déclaratif n'en avait aucune (audit Admin du 07/10/2026, FIN-01) :
 * un administrateur seul déclarait « remboursé » ou « refusé » n'importe quel
 * montant, alors que le virement du même montant exigeait deux personnes.
 */

/** Un virement humain au-delà du seuil. L'exécution automatique (D2) n'est pas un geste humain. */
export function executionNeedsApproval(
  refund: { amount: number },
  adminUserId: string | null,
): boolean {
  return adminUserId !== null && refund.amount >= REFUND_APPROVAL_THRESHOLD_XAF;
}

/**
 * Une clôture au-delà du seuil : « remboursé » (l'argent est réputé parti) ou
 * « refusé » (le client perd son dû, D-1). « En cours » n'engage rien.
 */
export function closureNeedsApproval(
  refund: { amount: number },
  target: RefundStatus,
): boolean {
  return (
    (target === RefundStatus.COMPLETED || target === RefundStatus.REJECTED) &&
    refund.amount >= REFUND_APPROVAL_THRESHOLD_XAF
  );
}

/**
 * Ce qu'une approbation de CLÔTURE autorise : ce remboursement, ce montant,
 * ce statut, cette note. `closeAs` la distingue d'une approbation de virement
 * (`refundApprovalPayload`) : même nature (`REFUND_EXECUTION`), empreintes
 * différentes — l'une ne peut jamais servir à l'autre.
 *
 * Une note vide est omise : le JSON stocké perd les clés `undefined`, et la
 * consommation recalcule l'empreinte à partir de ce qui a été stocké.
 */
export function refundClosurePayload(
  refund: { id: string; amount: number },
  closeAs: RefundStatus,
  notes?: string | null,
): {
  refundId: string;
  amountXaf: number;
  closeAs: RefundStatus;
  notes?: string;
} {
  const trimmed = notes?.trim();
  return {
    refundId: refund.id,
    amountXaf: refund.amount,
    closeAs,
    ...(trimmed ? { notes: trimmed } : {}),
  };
}

/** Lecture d'une charge utile stockée : est-ce une approbation de clôture ? */
export function closureFromPayload(
  payload: unknown,
): { closeAs: RefundStatus; notes?: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const { closeAs, notes } = payload as { closeAs?: unknown; notes?: unknown };
  if (closeAs !== RefundStatus.COMPLETED && closeAs !== RefundStatus.REJECTED) {
    return null;
  }
  return {
    closeAs,
    ...(typeof notes === 'string' && notes ? { notes } : {}),
  };
}
