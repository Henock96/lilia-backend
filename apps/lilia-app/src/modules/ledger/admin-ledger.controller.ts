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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminCapability, User } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  ExcludeOrderDto,
  LedgerCatchUpDto,
  ResolvePostingExceptionDto,
  ReverseLedgerTransactionDto,
} from './dto/ledger.dto';
import { LedgerPosterService } from './ledger-poster.service';
import { LedgerService } from './ledger.service';

/**
 * Grand livre — réservé à l'ADMIN (lot 2, 30/10/2026).
 *
 * Lecture : tout administrateur. Écritures (rattrapage, contre-passation,
 * exclusion, arbitrage) : `FINANCE_EXECUTE`. Aucune de ces routes ne fait
 * bouger d'argent : elles écrivent ce qui s'est passé, ou le corrigent par
 * contre-passation — jamais par réécriture.
 *
 * Les soldes livreurs restent ici, côté ADMIN : le livreur ne voit jamais sa
 * paie (règle 9, D-PAY).
 */
@ApiTags('Admin — Grand livre')
@ApiBearerAuth()
@Controller('admin/ledger')
@Roles('ADMIN')
export class AdminLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly poster: LedgerPosterService,
  ) {}

  @Get('balances')
  @ApiOperation({ summary: 'Soldes par compte et sous-compte' })
  balances(
    @Query('account') account?: string,
    @Query('subjectId') subjectId?: string,
  ) {
    return this.ledger.balances({ account, subjectId });
  }

  @Get('vendors/:restaurantId/balance')
  @ApiOperation({ summary: 'Ce que Lilia doit à un vendeur (grand livre)' })
  async vendorBalance(@Param('restaurantId') restaurantId: string) {
    return {
      restaurantId,
      balanceXaf: await this.ledger.vendorBalance(restaurantId),
    };
  }

  @Get('exceptions')
  @ApiOperation({ summary: 'Faits non écrits, en attente d’arbitrage' })
  exceptions(@Query('status') status?: 'OPEN' | 'RESOLVED') {
    return this.ledger.listExceptions(
      status === 'RESOLVED' ? 'RESOLVED' : 'OPEN',
    );
  }

  @Post('exceptions/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Arbitrer une exception, motif obligatoire' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  resolveException(
    @Param('id') id: string,
    @Body() dto: ResolvePostingExceptionDto,
    @CurrentUser() admin: User,
  ) {
    return this.ledger.resolveException({
      id,
      note: dto.note,
      actorUserId: admin.id,
    });
  }

  @Post('transactions/:id/reverse')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Contre-passer une transaction (une seule fois)' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  reverse(
    @Param('id') id: string,
    @Body() dto: ReverseLedgerTransactionDto,
    @CurrentUser() admin: User,
  ) {
    return this.ledger.reverse({
      txId: id,
      reason: dto.reason,
      actorUserId: admin.id,
    });
  }

  @Post('excluded-orders')
  @ApiOperation({ summary: 'Exclure une commande de test du grand livre' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  excludeOrder(@Body() dto: ExcludeOrderDto, @CurrentUser() admin: User) {
    return this.ledger.excludeOrder({
      orderId: dto.orderId,
      reason: dto.reason,
      actorUserId: admin.id,
    });
  }

  /**
   * Rattrapage à la demande — c'est par là que passe la reprise historique
   * (`backfillBefore`), avant d'allumer le posteur automatique.
   */
  @Throttle({ short: { limit: 1, ttl: 10000 }, long: { limit: 6, ttl: 60000 } })
  @Post('catch-up')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Écrire les faits durables pas encore au grand livre',
  })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  catchUp(@Body() dto: LedgerCatchUpDto) {
    return this.poster.catchUp({
      backfillBefore: dto.backfillBefore
        ? new Date(dto.backfillBefore)
        : undefined,
    });
  }
}
