import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  ConcludeFailureDto,
  DeclareDeliveryFailureDto,
} from './dto/delivery-failure.dto';
import { DeliveryFailureService } from './delivery-failure.service';

/** Échec de livraison (F3-05) — protocole et déclaration. */
@ApiTags('Deliveries')
@ApiBearerAuth()
@Controller('deliveries')
export class DeliveryFailureController {
  constructor(private readonly failures: DeliveryFailureService) {}

  /** Le client ne répond pas : SMS, push, et le minuteur démarre. */
  @Post(':id/unreachable/start')
  @Roles('LIVREUR')
  @HttpCode(HttpStatus.OK)
  // Un SMS part à chaque démarrage réel : borné, même si l'appel est idempotent.
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Démarrer le protocole « client injoignable »' })
  async start(@Param('id') id: string, @CurrentUser() user: User) {
    return { data: await this.failures.startUnreachable(id, user) };
  }

  @Post(':id/unreachable/call')
  @Roles('LIVREUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Journaliser une tentative d’appel au client' })
  async call(@Param('id') id: string, @CurrentUser() user: User) {
    return { data: await this.failures.logCall(id, user) };
  }

  /**
   * Déclarer l'échec — livreur titulaire (en course), vendeur (avant la
   * récupération), admin. La commande ne change pas : l'admin conclut.
   */
  @Post(':id/failure')
  @Roles('LIVREUR', 'RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Déclarer l’échec d’une livraison' })
  async declare(
    @Param('id') id: string,
    @Body() dto: DeclareDeliveryFailureDto,
    @CurrentUser() user: User,
  ) {
    return { data: await this.failures.declare(id, user, dto) };
  }
}

/** Arbitrage d'un échec de livraison (F3-05) — ADMIN. */
@ApiTags('Deliveries')
@ApiBearerAuth()
@Controller('admin/orders')
@Roles('ADMIN')
export class AdminDeliveryFailureController {
  constructor(private readonly failures: DeliveryFailureService) {}

  @Get(':id/failure-evidence')
  @ApiOperation({ summary: 'Preuves d’un échec (déclarations, protocole)' })
  async evidence(@Param('id') id: string) {
    return { data: await this.failures.evidence(id) };
  }

  /** `dryRun: true` rend les montants de la matrice sans rien écrire. */
  @Post(':id/conclude-failure')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Conclure un échec de livraison avec un responsable',
  })
  async conclude(
    @Param('id') id: string,
    @Body() dto: ConcludeFailureDto,
    @CurrentUser() admin: User,
  ) {
    return {
      data: await this.failures.conclude(
        id,
        admin,
        dto.liability,
        dto.dryRun ?? false,
      ),
    };
  }
}
