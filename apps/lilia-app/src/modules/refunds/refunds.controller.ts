/* eslint-disable prettier/prettier */
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { AdminCapability } from '@prisma/client';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  AdminAuditAction,
  ApprovalKind,
  RefundStatus,
  User,
} from '@prisma/client';

import { RefundsService } from './refunds.service';
import {
  RefundExecutionService,
  refundApprovalPayload,
} from './refund-execution.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { REFUND_APPROVAL_THRESHOLD_XAF } from '../approvals/approval-rules';
import { UpdateRefundStatusDto } from './dto/update-refund-status.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { AdminAuditService } from '../admin-audit/admin-audit.service';

/**
 * File des remboursements (fix H5). ADMIN uniquement : c'est une file de
 * travail interne, pas un self-service client.
 */
@ApiTags('Refunds')
@ApiBearerAuth()
@Controller('refunds')
@Roles('ADMIN')
export class RefundsController {
  constructor(
    private readonly refunds: RefundsService,
    private readonly execution: RefundExecutionService,
    private readonly audit: AdminAuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * Exécute le virement de remboursement au client.
   *
   * ⚠️ Geste **explicite**, jamais automatique — exactement comme le reversement
   * vendeur. Une annulation ouvre la dette (`Refund` `PENDING`) ; c'est un
   * administrateur qui décide de la solder, après avoir constaté qu'il n'y a pas
   * de litige. L'automatiser retirerait la seule fenêtre où un remboursement
   * reste simple.
   *
   * La destination n'est pas un paramètre : elle vient du numéro qui a payé.
   */
  @Post(':id/execute')
  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Virer le remboursement au client (ADMIN)' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  async execute(@Param('id') id: string, @CurrentUser() admin: User) {
    // F3-08 / D7 — au-delà du seuil, la demande part chez un second
    // administrateur, qui exécutera en approuvant.
    const pending = await this.refunds.findOne(id);
    if (pending.data.amount >= REFUND_APPROVAL_THRESHOLD_XAF) {
      const approval = await this.approvals.request({
        kind: ApprovalKind.REFUND_EXECUTION,
        refId: id,
        payload: refundApprovalPayload(pending.data),
        amountXaf: pending.data.amount,
        requestedBy: admin.id,
        summary: `Remboursement de ${pending.data.amount} FCFA (commande #${pending.data.orderId.slice(-6).toUpperCase()})`,
      });
      return {
        approvalRequired: true,
        approval,
        message: `Au-delà de ${REFUND_APPROVAL_THRESHOLD_XAF} FCFA, un second administrateur doit approuver le remboursement. Il partira à son approbation.`,
      };
    }
    const result = await this.execution.execute(id, admin.id);
    // Tracé comme un `REFUND_UPDATED` sur la COMMANDE, comme les autres gestes
    // de cette file : `AdminAuditLog.targetType` ne connaît que quatre entités,
    // et c'est la commande qui porte le sens pour qui relira le journal.
    const refund = await this.refunds.findOne(id);
    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.REFUND_UPDATED,
      targetType: 'Order',
      targetId: refund.data.orderId,
      metadata: { geste: 'execute', refundId: id, status: result.status },
    });
    return result;
  }

  @Get()
  @ApiOperation({ summary: 'Remboursements à traiter (les plus anciens d’abord)' })
  @ApiQuery({ name: 'status', required: false, enum: RefundStatus })
  list(
    @Query() query: PaginationQueryDto,
    @Query('status') status?: RefundStatus,
  ) {
    return this.refunds.list({ status, page: query.page, limit: query.limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’un remboursement' })
  findOne(@Param('id') id: string) {
    return this.refunds.findOne(id);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Faire avancer un remboursement' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateRefundStatusDto,
    @CurrentUser() admin: User,
  ) {
    const result = await this.refunds.updateStatus(
      id,
      dto.status,
      admin.id,
      dto.notes,
    );

    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.REFUND_UPDATED,
      targetType: 'Order',
      targetId: result.data.orderId,
      reason: dto.notes,
      metadata: { refundId: id, status: dto.status, amount: result.data.amount },
    });

    return result;
  }
}
