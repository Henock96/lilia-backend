import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminCapability, ApprovalKind, User } from '@prisma/client';

import { ApprovalsService } from '../approvals/approvals.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { NoShowPayoutState } from './no-show-payout.policy';
import { NoShowPayoutService } from './no-show-payout.service';

const STATES: NoShowPayoutState[] = [
  'NOTHING_DUE',
  'DUE',
  'IN_PROGRESS',
  'PAID',
];

export class ListNoShowsQueryDto {
  @IsOptional()
  @IsIn(STATES)
  state?: NoShowPayoutState;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * 4B-2 J6b — parts d'absence dues aux restaurants (`16-J6b-design.md`).
 *
 * La lecture est ouverte à tout administrateur (B-3). La demande de
 * versement exige `FINANCE_EXECUTE` et n'envoie rien : elle ouvre une
 * approbation, et le virement part à la validation d'un second
 * administrateur (`POST /admin/approvals/:id/approve`, `FINANCE_APPROVE` +
 * MFA). Aucun écran dans ce lot (B-4).
 */
@ApiTags('Réservations sur place (admin)')
@ApiBearerAuth()
@Controller('admin/reservation-no-shows')
@Roles('ADMIN')
export class AdminReservationNoShowsController {
  constructor(
    private readonly payouts: NoShowPayoutService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Absences et état du versement de la part restaurant',
  })
  async list(@Query() query: ListNoShowsQueryDto) {
    return {
      data: await this.payouts.list({
        state: query.state,
        limit: query.limit,
      }),
    };
  }

  @Post(':settlementId/payout')
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Demander le versement de la part restaurant d’une absence (validation par un second administrateur)',
  })
  async requestPayout(
    @Param('settlementId') settlementId: string,
    @CurrentUser() admin: User,
  ) {
    const prepared = await this.payouts.prepareRequest(settlementId);
    const approval = await this.approvals.request({
      kind: ApprovalKind.NO_SHOW_VENDOR_SHARE_PAYOUT,
      refId: settlementId,
      payload: { ...prepared.payload },
      amountXaf: prepared.amountXaf,
      requestedBy: admin.id,
      summary: prepared.summary,
    });
    return {
      data: { approvalRequired: true, approval },
      message:
        'Demande envoyée : le virement partira à la validation d’un second administrateur.',
    };
  }
}
