import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { AdminCapability } from '@prisma/client';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuditAction, User } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { ClaimsService } from './claims.service';
import {
  ClaimListQueryDto,
  CreateClaimDto,
  IssueVoucherDto,
  PostClaimMessageDto,
  RejectClaimDto,
} from './dto/claim.dto';

/**
 * Réclamations sur une commande livrée (F3-06).
 *
 * Trois publics, une seule ressource : le client voit les siennes (messages
 * `ALL`), le vendeur celles de sa boutique (et répond au support seul), le
 * support toutes. La portée est appliquée par le service, jamais par la route.
 */
@ApiTags('Claims')
@ApiBearerAuth()
@Controller()
export class ClaimsController {
  constructor(
    private readonly claims: ClaimsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Post('orders/:orderId/claims')
  @Roles('CLIENT')
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Ouvrir une réclamation (24 h après la livraison)' })
  async open(
    @Param('orderId') orderId: string,
    @Body() dto: CreateClaimDto,
    @CurrentUser() user: User,
  ) {
    const claim = await this.claims.open(orderId, user, dto);
    return {
      ...claim,
      message: 'Réclamation transmise. Le service client vous répond ici.',
    };
  }

  @Get('me/claims')
  @Roles('CLIENT')
  @ApiOperation({ summary: 'Mes demandes' })
  mine(@Query() query: ClaimListQueryDto, @CurrentUser() user: User) {
    return this.claims.list(user, query);
  }

  @Get('claims')
  @Roles('CLIENT', 'RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Réclamations visibles par l’appelant' })
  list(@Query() query: ClaimListQueryDto, @CurrentUser() user: User) {
    return this.claims.list(user, query);
  }

  @Get('claims/:id')
  @Roles('CLIENT', 'RESTAURATEUR', 'ADMIN')
  findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.claims.findOne(id, user);
  }

  @Post('claims/:id/messages')
  @Roles('CLIENT', 'RESTAURATEUR', 'ADMIN')
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 20, ttl: 60000 } })
  postMessage(
    @Param('id') id: string,
    @Body() dto: PostClaimMessageDto,
    @CurrentUser() user: User,
  ) {
    return this.claims.postMessage(id, user, dto);
  }

  @Post('admin/claims/:id/voucher')
  @Roles('ADMIN')
  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Clore par un avoir nominatif (code promo)' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  async voucher(
    @Param('id') id: string,
    @Body() dto: IssueVoucherDto,
    @CurrentUser() admin: User,
  ) {
    const result = await this.claims.issueVoucher(id, admin, dto);
    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.CLAIM_VOUCHER_ISSUED,
      targetType: 'Incident',
      targetId: id,
      metadata: { code: result.data.code, amountXaf: dto.amountXaf },
    });
    return result;
  }

  @Post('admin/claims/:id/reject')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refuser une réclamation (motif communiqué)' })
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectClaimDto,
    @CurrentUser() admin: User,
  ) {
    const result = await this.claims.reject(id, admin, dto);
    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.CLAIM_REJECTED,
      targetType: 'Incident',
      targetId: id,
      reason: dto.reason,
    });
    return result;
  }
}
