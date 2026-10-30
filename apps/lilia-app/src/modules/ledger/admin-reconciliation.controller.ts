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
  ImportReconciliationDto,
  ListReconciliationItemsQueryDto,
  ReconciliationNoteDto,
  ResolveReconciliationItemDto,
} from './dto/ledger.dto';
import { ReconciliationService } from './reconciliation.service';

/**
 * Rapprochement Lilia ↔ prestataire — réservé à l'ADMIN (lot 2, 30/10/2026).
 *
 * Lecture : tout administrateur. Import, passage et résolution :
 * `FINANCE_EXECUTE` (+ second facteur quand `ADMIN_MFA_REQUIRED`) — un écart
 * ouvert bloque des versements, en résoudre un les débloque.
 *
 * Chaque geste est nominatif dans ses propres tables
 * (`ReconciliationRun.createdBy`, `ReconciliationItemEvent.actorUserId`).
 */
@ApiTags('Admin — Rapprochement')
@ApiBearerAuth()
@Controller('admin/reconciliation')
@Roles('ADMIN')
export class AdminReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Écarts ouverts, blocages, dernier passage' })
  summary() {
    return this.reconciliation.summary();
  }

  @Get('items')
  @ApiOperation({ summary: 'Écarts de rapprochement' })
  listItems(@Query() q: ListReconciliationItemsQueryDto) {
    return this.reconciliation.listItems(q);
  }

  @Get('items/:id')
  @ApiOperation({ summary: "Détail d'un écart et son journal" })
  getItem(@Param('id') id: string) {
    return this.reconciliation.getItem(id);
  }

  @Get('runs')
  @ApiOperation({ summary: 'Passages de rapprochement' })
  listRuns() {
    return this.reconciliation.listRuns();
  }

  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 20, ttl: 60000 } })
  @Post('imports')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Importer un export prestataire normalisé' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  importExport(
    @Body() dto: ImportReconciliationDto,
    @CurrentUser() admin: User,
  ) {
    return this.reconciliation.importProviderExport({
      periodStart: new Date(dto.periodStart),
      periodEnd: new Date(dto.periodEnd),
      walletBalanceXaf: dto.walletBalanceXaf ?? null,
      rows: dto.rows,
      actorUserId: admin.id,
    });
  }

  @Throttle({ short: { limit: 1, ttl: 2000 }, long: { limit: 20, ttl: 60000 } })
  @Post('scans')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Contrôles sur la base seule' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  scan(@CurrentUser() admin: User) {
    return this.reconciliation.scanInternal({ actorUserId: admin.id });
  }

  @Post('items/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Résoudre un écart, motif obligatoire' })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveReconciliationItemDto,
    @CurrentUser() admin: User,
  ) {
    return this.reconciliation.resolve({
      itemId: id,
      kind: dto.kind,
      note: dto.note,
      actorUserId: admin.id,
    });
  }

  @Post('items/:id/notes')
  @ApiOperation({ summary: 'Ajouter une note à un écart' })
  addNote(
    @Param('id') id: string,
    @Body() dto: ReconciliationNoteDto,
    @CurrentUser() admin: User,
  ) {
    return this.reconciliation.addNote({
      itemId: id,
      note: dto.note,
      actorUserId: admin.id,
    });
  }
}
