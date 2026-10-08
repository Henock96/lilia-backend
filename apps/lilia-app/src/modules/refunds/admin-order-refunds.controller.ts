import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { AdminCapability } from '@prisma/client';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuditAction, ApprovalKind, User } from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import * as Sentry from '@sentry/nestjs';
import { refundApprovalPayload } from './refund-execution.service';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { ComposeRefundDto } from './dto/compose-refund.dto';
import { RefundComposerService } from './refund-composer.service';

/**
 * Remboursement partiel d'une commande (F3-06) — ADMIN.
 *
 * `quote` et `create` passent par le même calcul serveur : l'écran affiche ce
 * que l'écriture appliquera, jamais un total recalculé côté navigateur.
 */
@ApiTags('Refunds')
@ApiBearerAuth()
@Controller('admin/orders')
@Roles('ADMIN')
export class AdminOrderRefundsController {
  private readonly logger = new Logger(AdminOrderRefundsController.name);

  constructor(
    private readonly composer: RefundComposerService,
    private readonly audit: AdminAuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Post(':orderId/refunds/quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aperçu d’un remboursement partiel (rien n’est écrit)',
  })
  async quote(
    @Param('orderId') orderId: string,
    @Body() dto: ComposeRefundDto,
  ) {
    return { data: await this.composer.quote(orderId, dto) };
  }

  @Post(':orderId/refunds')
  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Rembourser des articles, des frais ou un geste' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  async create(
    @Param('orderId') orderId: string,
    @Body() dto: ComposeRefundDto,
    @CurrentUser() admin: User,
  ) {
    const created = await this.composer.create(orderId, dto, admin.id);
    // R-01 (FIN-02) — au-delà du seuil, le virement attend un second
    // administrateur : on ouvre sa demande ici (le compositeur vit dans le
    // module cœur, sans accès aux approbations). Le remboursement est déjà
    // écrit : un échec de la demande ne doit pas faire croire le contraire —
    // elle reste ouvrable depuis la file (« Virer au client »).
    let approvalId: string | null = null;
    let message = created.execution.message;
    if (created.execution.approvalRequired) {
      try {
        const approval = await this.approvals.request({
          kind: ApprovalKind.REFUND_EXECUTION,
          refId: created.refundId,
          payload: refundApprovalPayload({
            id: created.refundId,
            amount: created.amountXaf,
          }),
          amountXaf: created.amountXaf,
          requestedBy: admin.id,
          summary: `Remboursement de ${created.amountXaf} FCFA (commande #${orderId.slice(-6).toUpperCase()})`,
        });
        approvalId = approval.id;
      } catch (error) {
        // Le remboursement vient d'être créé : aucune demande ne peut déjà
        // l'attendre. Toute erreur ici est anormale, et une dette au-delà du
        // seuil sans demande ouverte ne doit pas dormir dans les seuls logs.
        this.logger.error(
          `Demande d'approbation non ouverte pour le remboursement ${created.refundId} : ${(error as Error).message}`,
        );
        Sentry.captureException(error, {
          tags: { flow: 'refund.compose.approval' },
          extra: { refundId: created.refundId, amountXaf: created.amountXaf },
        });
        message =
          'Remboursement enregistré, mais la demande d’approbation n’a pas pu être ouverte : relancez « Virer au client » depuis la file Remboursements.';
      }
    }
    const result = {
      ...created,
      execution: { ...created.execution, approvalId },
    };
    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.REFUND_CREATED,
      targetType: 'Order',
      targetId: orderId,
      reason: dto.note ?? null,
      metadata: {
        refundId: result.refundId,
        amountXaf: result.amountXaf,
        reasonCode: dto.reasonCode,
        bearer: result.bearer,
        incidentId: dto.incidentId ?? null,
        executed: result.execution.executed,
        approvalId,
      },
    });
    return {
      data: result,
      message: result.execution.executed ? 'Remboursement envoyé.' : message,
    };
  }
}
