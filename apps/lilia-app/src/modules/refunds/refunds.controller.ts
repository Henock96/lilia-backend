/* eslint-disable prettier/prettier */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminAuditAction, RefundStatus, User } from '@prisma/client';

import { RefundsService } from './refunds.service';
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
    private readonly audit: AdminAuditService,
  ) {}

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
