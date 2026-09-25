import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AdminAuditAction,
  AdminCapability,
  ApprovalKind,
  ApprovalStatus,
  FinancialApproval,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { APPROVAL_REQUESTED_EVENT } from '../outbox/outbox-events';
import {
  applyPayoutAccount,
  PayoutAccountPayload,
} from '../payments/payout-account';
import { maskPhone } from '../payments/services/payment.service';
import { payoutAccountCooldownHours } from '../payments/services/restaurant-payout.service';
import { RefundExecutionService } from '../refunds/refund-execution.service';
import { UserCacheService } from '../auth/services/user-cache.service';
import {
  APPROVAL_TTL_HOURS,
  approvalPayloadHash,
  consumeApproval,
} from './approval-rules';

/** Charge utile d'une attribution de capacités. */
export interface CapabilityGrantPayload {
  capabilities: AdminCapability[];
}

/**
 * Gestes financiers à deux administrateurs (F3-08, R-08.4).
 *
 * Un administrateur DEMANDE ; un autre, porteur de `FINANCE_APPROVE`,
 * APPROUVE — et le geste s'exécute alors, l'approbation étant consommée dans
 * la transaction du geste. Celui qui demande ne peut pas approuver : c'est une
 * CHECK en base (`FinancialApproval_four_eyes`), pas seulement ce service.
 *
 * Un seul administrateur disponible : la demande expire au bout de 24 h
 * (R-08.5). Aucun contournement n'existe dans le code — le « break-glass » est
 * une procédure écrite (`docs/RUNBOOK_ADMIN.md`).
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly outbox: OutboxService,
    private readonly refundExecution: RefundExecutionService,
    private readonly userCache: UserCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Ouvre une demande. Une seule demande en attente par (nature, objet) :
   * l'index unique partiel arbitre deux demandes simultanées.
   */
  async request(params: {
    kind: ApprovalKind;
    refId: string;
    payload: Prisma.InputJsonValue;
    amountXaf?: number | null;
    requestedBy: string;
    summary: string;
  }): Promise<FinancialApproval> {
    try {
      const approval = await this.prisma.$transaction(async (tx) => {
        const created = await tx.financialApproval.create({
          data: {
            kind: params.kind,
            refId: params.refId,
            payload: params.payload,
            payloadHash: approvalPayloadHash(
              params.kind,
              params.refId,
              params.payload,
            ),
            amountXaf: params.amountXaf ?? null,
            requestedBy: params.requestedBy,
            expiresAt: new Date(Date.now() + APPROVAL_TTL_HOURS * 3_600_000),
          },
        });
        // Le second administrateur doit LE SAVOIR : une demande que personne
        // ne voit expire en silence. Écrit avec la demande (outbox).
        await this.outbox.enqueueInTransaction(tx, {
          type: APPROVAL_REQUESTED_EVENT,
          aggregateId: created.id,
          payload: {
            approvalId: created.id,
            requestedBy: params.requestedBy,
            summary: params.summary,
          },
        });
        return created;
      });
      await this.audit.record({
        actorId: params.requestedBy,
        action: AdminAuditAction.APPROVAL_REQUESTED,
        targetType: 'FinancialApproval',
        targetId: approval.id,
        metadata: {
          kind: params.kind,
          refId: params.refId,
          summary: params.summary,
        },
      });
      return approval;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const pending = await this.prisma.financialApproval.findFirst({
          where: {
            kind: params.kind,
            refId: params.refId,
            status: ApprovalStatus.PENDING,
          },
          select: { id: true },
        });
        throw new ConflictException({
          message:
            'Une demande est déjà en attente d’approbation pour ce geste. Un second administrateur doit la traiter.',
          code: 'APPROVAL_ALREADY_PENDING',
          approvalId: pending?.id ?? null,
        });
      }
      throw error;
    }
  }

  /** File des demandes. Les demandes échues sont marquées EXPIRED au passage. */
  async list(status: ApprovalStatus | undefined, limit = 50) {
    await this.expireOverdue();
    return this.prisma.financialApproval.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Approuve ET exécute. Un geste qui échoue après l'approbation (prestataire
   * injoignable) laisse l'approbation APPROVED : le même approbateur peut
   * relancer, jusqu'à l'expiration — jamais un autre geste.
   */
  async approve(approvalId: string, approverId: string) {
    const approval = await this.load(approvalId);
    if (approval.requestedBy === approverId) {
      throw new ForbiddenException({
        message:
          'Vous avez demandé ce geste : un autre administrateur doit l’approuver.',
        code: 'APPROVAL_SELF_FORBIDDEN',
      });
    }
    if (approval.expiresAt <= new Date() && approval.status === 'PENDING') {
      await this.expireOverdue();
      throw new ConflictException({
        message: 'Cette demande a expiré. Elle doit être refaite.',
        code: 'APPROVAL_EXPIRED',
      });
    }
    const relaunch =
      approval.status === ApprovalStatus.APPROVED &&
      approval.approvedBy === approverId;
    if (approval.status !== ApprovalStatus.PENDING && !relaunch) {
      throw new ConflictException({
        message: `Cette demande n’est plus en attente (${approval.status}).`,
        code: 'APPROVAL_NOT_PENDING',
      });
    }

    const result =
      approval.kind === ApprovalKind.REFUND_EXECUTION
        ? await this.approveRefund(approval, approverId, relaunch)
        : await this.prisma.$transaction(async (tx) => {
            if (!relaunch) await this.markApproved(tx, approval, approverId);
            return approval.kind === ApprovalKind.PAYOUT_ACCOUNT_CHANGE
              ? this.applyPayoutAccountChange(tx, approval, approverId)
              : this.applyCapabilityGrant(tx, approval, approverId);
          });

    await this.audit.record({
      actorId: approverId,
      action: AdminAuditAction.APPROVAL_DECIDED,
      targetType: 'FinancialApproval',
      targetId: approval.id,
      metadata: {
        kind: approval.kind,
        refId: approval.refId,
        decision: 'APPROVED',
      },
    });
    await this.afterApproval(approval);
    return result;
  }

  async reject(approvalId: string, approverId: string, reason: string) {
    const approval = await this.load(approvalId);
    // Le demandeur peut retirer sa propre demande : c'est une annulation, pas
    // une approbation — la CHECK des 4 yeux ne vise que `approvedBy`.
    const { count } = await this.prisma.financialApproval.updateMany({
      where: { id: approval.id, status: ApprovalStatus.PENDING },
      data:
        approval.requestedBy === approverId
          ? { status: ApprovalStatus.EXPIRED, reason: `Retirée : ${reason}` }
          : {
              status: ApprovalStatus.REJECTED,
              approvedBy: approverId,
              decidedAt: new Date(),
              reason,
            },
    });
    if (count === 0) {
      throw new ConflictException({
        message: 'Cette demande n’est plus en attente.',
        code: 'APPROVAL_NOT_PENDING',
      });
    }
    await this.audit.record({
      actorId: approverId,
      action: AdminAuditAction.APPROVAL_DECIDED,
      targetType: 'FinancialApproval',
      targetId: approval.id,
      reason,
      metadata: {
        kind: approval.kind,
        refId: approval.refId,
        decision: 'REJECTED',
      },
    });
    return { id: approval.id, status: 'REJECTED' as const };
  }

  // ─── Gestes exécutés à l'approbation ──────────────────────────────────────

  private async applyPayoutAccountChange(
    tx: Prisma.TransactionClient,
    approval: FinancialApproval,
    approverId: string,
  ) {
    const payload = approval.payload as unknown as PayoutAccountPayload;
    await consumeApproval(tx, {
      approvalId: approval.id,
      kind: approval.kind,
      refId: approval.refId,
      payload,
    });
    const before = await tx.restaurant.findUniqueOrThrow({
      where: { id: approval.refId },
      select: { payoutPhoneNumber: true },
    });
    const updated = await applyPayoutAccount(tx, {
      restaurantId: approval.refId,
      payoutPhoneNumber: payload.payoutPhoneNumber,
      payoutProvider: payload.payoutProvider,
      payoutAccountName: payload.payoutAccountName,
      verifiedById: approverId,
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: approval.requestedBy,
        action: AdminAuditAction.VENDOR_PAYOUT_ACCOUNT_UPDATED,
        targetType: 'Restaurant',
        targetId: approval.refId,
        metadata: {
          from: maskPhone(before.payoutPhoneNumber ?? undefined),
          to: maskPhone(payload.payoutPhoneNumber),
          provider: payload.payoutProvider,
          approvalId: approval.id,
          approvedBy: approverId,
        },
      },
    });
    return {
      kind: approval.kind,
      restaurantId: updated.id,
      payoutPhoneNumber: maskPhone(updated.payoutPhoneNumber ?? undefined),
      restaurantName: updated.nom,
    };
  }

  private async applyCapabilityGrant(
    tx: Prisma.TransactionClient,
    approval: FinancialApproval,
    approverId: string,
  ) {
    const payload = approval.payload as unknown as CapabilityGrantPayload;
    await consumeApproval(tx, {
      approvalId: approval.id,
      kind: approval.kind,
      refId: approval.refId,
      payload,
    });
    const target = await tx.user.findUniqueOrThrow({
      where: { id: approval.refId },
      select: { role: true, adminCapabilities: true },
    });
    if (target.role !== 'ADMIN') {
      throw new ConflictException({
        message: 'Les capacités ne s’attribuent qu’à un administrateur.',
        code: 'NOT_AN_ADMIN',
      });
    }
    const updated = await tx.user.update({
      where: { id: approval.refId },
      data: { adminCapabilities: payload.capabilities },
      select: { id: true, firebaseUid: true, adminCapabilities: true },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: approval.requestedBy,
        action: AdminAuditAction.CAPABILITY_CHANGED,
        targetType: 'User',
        targetId: approval.refId,
        metadata: {
          from: target.adminCapabilities,
          to: payload.capabilities,
          approvalId: approval.id,
          approvedBy: approverId,
        },
      },
    });
    return {
      kind: approval.kind,
      userId: updated.id,
      firebaseUid: updated.firebaseUid,
      adminCapabilities: updated.adminCapabilities,
    };
  }

  /**
   * Remboursement : le virement est un appel réseau, il ne tient pas dans une
   * transaction. On approuve d'abord, puis l'exécution consomme l'approbation
   * dans SA transaction de réservation — pour le compte du demandeur.
   */
  private async approveRefund(
    approval: FinancialApproval,
    approverId: string,
    relaunch: boolean,
  ) {
    if (!relaunch) {
      await this.prisma.$transaction((tx) =>
        this.markApproved(tx, approval, approverId),
      );
    }
    const executed = await this.refundExecution.execute(
      approval.refId,
      approval.requestedBy,
      { approvalId: approval.id },
    );
    return {
      kind: approval.kind,
      refundId: approval.refId,
      execution: executed,
    };
  }

  // ─── Outils ──────────────────────────────────────────────────────────────

  private async markApproved(
    tx: Prisma.TransactionClient,
    approval: FinancialApproval,
    approverId: string,
  ) {
    const { count } = await tx.financialApproval.updateMany({
      where: {
        id: approval.id,
        status: ApprovalStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      data: {
        status: ApprovalStatus.APPROVED,
        approvedBy: approverId,
        decidedAt: new Date(),
      },
    });
    if (count === 0) {
      throw new ConflictException({
        message:
          'Cette demande vient d’être traitée par un autre administrateur.',
        code: 'APPROVAL_NOT_PENDING',
      });
    }
  }

  /** Effets hors transaction, une fois le geste validé. */
  private async afterApproval(approval: FinancialApproval) {
    if (approval.kind === ApprovalKind.PAYOUT_ACCOUNT_CHANGE) {
      const payload = approval.payload as unknown as PayoutAccountPayload;
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: approval.refId },
        select: { nom: true },
      });
      // Fix F-08 — le vendeur apprend TOUJOURS que son compte a changé.
      this.eventEmitter.emit('vendor.payout_account.changed', {
        restaurantId: approval.refId,
        restaurantName: restaurant?.nom ?? '',
        maskedPhone: maskPhone(payload.payoutPhoneNumber),
        cooldownHours: payoutAccountCooldownHours(),
      });
    }
    if (approval.kind === ApprovalKind.CAPABILITY_GRANT) {
      const user = await this.prisma.user.findUnique({
        where: { id: approval.refId },
        select: { firebaseUid: true },
      });
      // Capacités lues depuis le cache utilisateur : le vider rend le
      // changement effectif tout de suite, pas dans 5 minutes.
      if (user) await this.userCache.invalidate(user.firebaseUid);
    }
  }

  private async load(id: string): Promise<FinancialApproval> {
    const approval = await this.prisma.financialApproval.findUnique({
      where: { id },
    });
    if (!approval) throw new NotFoundException('Demande introuvable.');
    return approval;
  }

  private async expireOverdue(): Promise<void> {
    const { count } = await this.prisma.financialApproval.updateMany({
      where: { status: ApprovalStatus.PENDING, expiresAt: { lte: new Date() } },
      data: { status: ApprovalStatus.EXPIRED },
    });
    if (count > 0)
      this.logger.warn(`⏳ ${count} demande(s) d'approbation expirée(s)`);
  }
}
