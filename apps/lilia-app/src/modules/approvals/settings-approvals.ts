import { ConflictException } from '@nestjs/common';
import { AdminAuditAction, FinancialApproval, Prisma } from '@prisma/client';

import {
  assertDeliveryPricingSwitch,
  FinancialSettingKey,
  PlatformSettingsChangePayload,
  staleFinancialKeys,
} from '../platform-settings/financial-settings';
import { consumeApproval } from './approval-rules';

/**
 * R-09 — application, à l'approbation, des deux gestes « réglage qui fixe de
 * l'argent ». Fonctions sur un client de transaction, comme
 * `applyPayoutAccount` : `ApprovalsService.approve` les appelle dans SA
 * transaction, après `markApproved`.
 *
 * Toute erreur levée ici annule la transaction entière : l'approbation n'est
 * alors ni marquée approuvée ni consommée (piège R-01, `count === 0` levé hors
 * transaction).
 */

export const PLATFORM_SETTINGS_REF = 'platform-settings';

export interface VendorCommissionChangePayload {
  /** `null` = le vendeur revient au taux plateforme. */
  commissionPercent: number | null;
  /** Valeur au moment de la demande : l'approbation ne vaut que pour elle. */
  before: number | null;
}

function approvalStale(fields: string[]): ConflictException {
  return new ConflictException({
    message:
      'Ce réglage a changé depuis la demande : rien n’a été appliqué. Rejetez cette demande, puis refaites-la sur les valeurs actuelles.',
    code: 'APPROVAL_STALE',
    fields,
  });
}

export async function applyPlatformSettingsChange(
  tx: Prisma.TransactionClient,
  approval: FinancialApproval,
  approverId: string,
) {
  const payload = approval.payload as unknown as PlatformSettingsChangePayload;
  await consumeApproval(tx, {
    approvalId: approval.id,
    kind: approval.kind,
    refId: approval.refId,
    payload,
  });

  const current = await tx.platformSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
  });
  const stale = staleFinancialKeys(current, payload.before);
  if (stale.length > 0) throw approvalStale(stale);

  // La grille a pu être dépubliée entre la demande et l'approbation.
  await assertDeliveryPricingSwitch(
    tx,
    current.deliveryPricingMode,
    payload.changes.deliveryPricingMode as
      | typeof current.deliveryPricingMode
      | undefined,
  );

  const { count } = await tx.platformSettings.updateMany({
    where: { id: 'singleton', updatedAt: current.updatedAt },
    data: payload.changes as Prisma.PlatformSettingsUpdateManyMutationInput,
  });
  if (count === 0) {
    throw approvalStale(Object.keys(payload.changes));
  }

  const diff = Object.fromEntries(
    (Object.keys(payload.changes) as FinancialSettingKey[]).map((k) => [
      k,
      { before: payload.before[k] ?? null, after: payload.changes[k] ?? null },
    ]),
  );
  await tx.adminAuditLog.create({
    data: {
      // Le geste appartient au demandeur ; l'approbateur est nommé à côté.
      actorId: approval.requestedBy,
      action: AdminAuditAction.PLATFORM_SETTINGS_CHANGED,
      targetType: 'User', // pas de cible métier : le réglage est global
      targetId: PLATFORM_SETTINGS_REF,
      metadata: {
        ...diff,
        approvalId: approval.id,
        approvedBy: approverId,
      } as Prisma.InputJsonValue,
    },
  });

  return { kind: approval.kind, changes: payload.changes };
}

export async function applyVendorCommissionChange(
  tx: Prisma.TransactionClient,
  approval: FinancialApproval,
  approverId: string,
) {
  const payload = approval.payload as unknown as VendorCommissionChangePayload;
  await consumeApproval(tx, {
    approvalId: approval.id,
    kind: approval.kind,
    refId: approval.refId,
    payload,
  });

  // Écriture conditionnelle sur la valeur lue à la demande : c'est PostgreSQL,
  // pas un `if`, qui ferme la fenêtre entre la relecture et l'écriture.
  const { count } = await tx.restaurant.updateMany({
    where: { id: approval.refId, commissionPercent: payload.before },
    data: { commissionPercent: payload.commissionPercent },
  });
  if (count === 0) throw approvalStale(['commissionPercent']);

  await tx.adminAuditLog.create({
    data: {
      actorId: approval.requestedBy,
      action: AdminAuditAction.VENDOR_COMMISSION_CHANGED,
      targetType: 'Restaurant',
      targetId: approval.refId,
      metadata: {
        from: payload.before,
        to: payload.commissionPercent,
        approvalId: approval.id,
        approvedBy: approverId,
      },
    },
  });

  return {
    kind: approval.kind,
    restaurantId: approval.refId,
    commissionPercent: payload.commissionPercent,
  };
}
