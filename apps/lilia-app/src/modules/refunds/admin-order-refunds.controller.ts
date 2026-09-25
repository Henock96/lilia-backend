import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { AdminCapability } from '@prisma/client';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuditAction, User } from '@prisma/client';

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
  constructor(
    private readonly composer: RefundComposerService,
    private readonly audit: AdminAuditService,
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
    const result = await this.composer.create(orderId, dto, admin.id);
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
      },
    });
    return {
      data: result,
      message: result.execution.executed
        ? 'Remboursement envoyé.'
        : result.execution.message,
    };
  }
}
