import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ApprovalKind, ApprovalStatus, Prisma } from '@prisma/client';

/**
 * Règles des gestes financiers à deux administrateurs (F3-08, D7).
 *
 * Fonctions sur un client de transaction, sans injection : les services qui
 * exécutent un geste approuvé (versements, remboursements) consomment
 * l'approbation dans LEUR transaction, sans dépendre du module d'approbation.
 */

/**
 * D7 — un remboursement exécuté à partir de ce montant exige un second
 * administrateur. Une constante et non un paramètre plateforme : un compte
 * compromis ne doit pas pouvoir relever le seuil qui le surveille.
 */
export const REFUND_APPROVAL_THRESHOLD_XAF = 50_000;

/** R-08.5 — une demande non décidée expire ; jamais de contournement. */
export const APPROVAL_TTL_HOURS = 24;

/** JSON à clés triées : deux payloads égaux donnent la même empreinte. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Empreinte du geste : l'approbation ne vaut que pour CE compte, CE montant,
 * CES capacités. Approuver « 06 111 » n'autorise pas « 06 222 ».
 */
export function approvalPayloadHash(
  kind: ApprovalKind,
  refId: string,
  payload: unknown,
): string {
  return createHash('sha256')
    .update(`${kind}|${refId}|${stableJson(payload)}`)
    .digest('hex');
}

/**
 * Consomme une approbation DANS la transaction du geste : une approbation ne
 * sert qu'une fois, et seulement pour le geste exact qu'elle décrit. Deux
 * exécutions simultanées : la seconde affecte 0 ligne et lève.
 */
export async function consumeApproval(
  tx: Prisma.TransactionClient,
  params: {
    approvalId: string;
    kind: ApprovalKind;
    refId: string;
    payload: unknown;
  },
): Promise<void> {
  const { count } = await tx.financialApproval.updateMany({
    where: {
      id: params.approvalId,
      kind: params.kind,
      refId: params.refId,
      status: ApprovalStatus.APPROVED,
      payloadHash: approvalPayloadHash(
        params.kind,
        params.refId,
        params.payload,
      ),
    },
    data: { status: ApprovalStatus.CONSUMED, consumedAt: new Date() },
  });
  if (count === 0) {
    throw new ConflictException({
      message:
        'Cette approbation n’est pas utilisable pour ce geste (déjà utilisée, expirée, ou pour un autre montant).',
      code: 'APPROVAL_NOT_USABLE',
    });
  }
}
