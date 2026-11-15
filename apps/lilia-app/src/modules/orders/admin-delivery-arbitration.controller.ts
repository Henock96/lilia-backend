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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DecodedIdToken } from 'firebase-admin/auth';

import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { DeliveryArbitrationService } from './delivery-arbitration.service';
import { ArbitrateDeliveryDto } from './dto/arbitrate-delivery.dto';

/**
 * Arbitrage de livraison (retours produit du 15/11/2026, D1) — l'ADMIN
 * clôture une livraison sans le livreur, par exemple quand le client refuse
 * une commande payée.
 *
 * La clôture pose `DELIVERY_ADMIN_OVERRIDE`, qui ouvre le versement du
 * vendeur, et peut émettre un avoir : capacité `FINANCE_EXECUTE` (donc MFA,
 * `AdminSecurityGuard`) et motif obligatoires, comme l'arbitrage de retrait.
 *
 * Réponse réduite : identifiant, statut, preuve et, s'il y en a un, l'avoir —
 * son code sert à l'administrateur qui a le client au téléphone.
 */
@ApiTags('Orders')
@ApiBearerAuth()
@Controller('admin/orders')
@Roles('ADMIN')
export class AdminDeliveryArbitrationController {
  constructor(private readonly arbitration: DeliveryArbitrationService) {}

  @Post(':id/delivery/arbitrate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 20, ttl: 60000 } })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  @ApiOperation({
    summary:
      'Clôturer une livraison sans le livreur (ADMIN, motif obligatoire, avoir facultatif)',
  })
  async arbitrate(
    @Param('id') id: string,
    @Body() dto: ArbitrateDeliveryDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    const result = await this.arbitration.arbitrate(id, fbUser.uid, {
      reason: dto.reason,
      ...(dto.note?.trim() ? { note: dto.note.trim() } : {}),
      ...(dto.voucherAmountXaf !== undefined
        ? { voucherAmountXaf: dto.voucherAmountXaf }
        : {}),
      ...(dto.voucherExpiresInDays !== undefined
        ? { voucherExpiresInDays: dto.voucherExpiresInDays }
        : {}),
    });
    return { data: result };
  }
}
