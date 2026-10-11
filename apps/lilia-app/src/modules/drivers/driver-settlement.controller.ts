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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminAuditAction, User } from '@prisma/client';

import { DriverSettlementService } from './driver-settlement.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import {
  CancelSettlementDto,
  OutstandingQueryDto,
  RecordSettlementDto,
} from './dto/driver-settlement.dto';

/**
 * Règlements livreurs — **réservé à l'administration**.
 *
 * Contrôleur distinct de `admin/drivers` plutôt qu'ajout de routes : sous
 * `admin/drivers`, une route littérale `settlements/...` entrerait en
 * concurrence avec `:id`, et l'ordre de déclaration deviendrait une règle
 * tacite à respecter. Un préfixe propre supprime la question.
 *
 * ⚠️ Aucune de ces routes n'envoie d'argent. Le versement se fait hors
 * application ; on en tient le registre.
 */
@ApiTags('Règlements livreurs (admin)')
@ApiBearerAuth()
@Controller('admin/driver-settlements')
@Roles('ADMIN')
export class AdminDriverSettlementsController {
  constructor(
    private readonly settlements: DriverSettlementService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Ce qui reste dû à un livreur — **lecture pure**.
   *
   * Ne crée rien, ne verrouille rien : elle peut être consultée autant de fois
   * que nécessaire. `coveredUntil` est rendu dans la réponse pour être rejoué
   * tel quel à l'enregistrement.
   */
  @Get('outstanding/:driverId')
  @ApiOperation({ summary: 'Montant dû à un livreur (lecture seule)' })
  async outstanding(
    @Param('driverId') driverId: string,
    @Query() query: OutstandingQueryDto,
  ) {
    const coveredUntil = query.coveredUntil
      ? new Date(query.coveredUntil)
      : new Date();
    return {
      data: await this.settlements.getOutstanding(driverId, coveredUntil),
    };
  }

  /**
   * Enregistre un versement **déjà effectué**.
   *
   * Throttle serré : chaque appel fige des courses et crée une pièce
   * comptable. Tracé dans `AdminAuditLog` — un mouvement d'argent vers un tiers
   * doit laisser une trace nominative opposable.
   */
  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 30, ttl: 60000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Enregistrer un règlement livreur déjà versé' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  async record(@Body() dto: RecordSettlementDto, @CurrentUser() admin: User) {
    const settlement = await this.settlements.record({
      driverId: dto.driverId,
      coveredUntil: new Date(dto.coveredUntil),
      method: dto.method,
      adminId: admin.id,
      paidAt: dto.paidAt ? new Date(dto.paidAt) : undefined,
      reference: dto.reference,
      note: dto.note,
    });

    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.DRIVER_SETTLEMENT_RECORDED,
      targetType: 'User',
      targetId: dto.driverId,
      reason: dto.note,
      metadata: {
        settlementId: settlement.id,
        amountXaf: settlement.amountXaf,
        courseCount: settlement.courseCount,
        method: settlement.method,
        reference: settlement.reference,
        coveredUntil: dto.coveredUntil,
      },
    });

    return { data: settlement, message: 'Règlement enregistré.' };
  }

  /** Annule une saisie erronée et libère les courses. */
  @Post(':settlementId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Annuler un règlement saisi par erreur' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  async cancel(
    @Param('settlementId') settlementId: string,
    @Body() dto: CancelSettlementDto,
    @CurrentUser() admin: User,
  ) {
    const settlement = await this.settlements.cancel(
      settlementId,
      admin.id,
      dto.reason,
    );

    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.DRIVER_SETTLEMENT_CANCELLED,
      targetType: 'User',
      targetId: settlement.driverId,
      reason: dto.reason,
      metadata: { settlementId, amountXaf: settlement.amountXaf },
    });

    return { data: settlement, message: 'Règlement annulé, courses libérées.' };
  }

  @Get()
  @ApiOperation({ summary: 'Historique des règlements d’un livreur' })
  async list(
    @Query('driverId') driverId: string,
    @Query() page: PaginationQueryDto,
  ) {
    return this.settlements.listForDriver(driverId, page.page, page.limit);
  }
}

// `DriverEarningsController` (`GET /drivers/me/earnings*`) a été retiré
// (D-PAY, décision Q6 du 27/09/2026 — DEL-002) : le livreur ne voit jamais sa
// rémunération, ni par course ni en cumul. Les règlements restent consultables
// par l'ADMIN seul (`AdminDriverSettlementsController` ci-dessus). Une
// application livreur antérieure qui ouvre « Mes gains » reçoit un 404.
