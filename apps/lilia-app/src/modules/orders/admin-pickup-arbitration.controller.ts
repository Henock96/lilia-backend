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
import { ArbitratePickupDto } from './dto/arbitrate-pickup.dto';
import { OrdersService } from './orders.service';

/**
 * 1B (ADM-03, D-1) — arbitrage de la remise d'un retrait par l'ADMIN.
 *
 * La remise forcée pose `PICKUP_ADMIN_OVERRIDE`, preuve qui ouvre une échéance
 * de versement vendeur : un rôle ADMIN ne suffit pas, il faut la capacité
 * `FINANCE_EXECUTE` (donc, `ADMIN_MFA_REQUIRED` allumé, second facteur et
 * authentification de moins de 15 min — `AdminSecurityGuard`), et un motif.
 *
 * Réponse volontairement réduite : l'identifiant, le statut et la preuve, pas
 * la commande et son vendeur complets.
 */
@ApiTags('Orders')
@ApiBearerAuth()
@Controller('admin/orders')
@Roles('ADMIN')
export class AdminPickupArbitrationController {
  constructor(private readonly orders: OrdersService) {}

  @Post(':id/pickup/arbitrate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 20, ttl: 60000 } })
  @RequireCapability(AdminCapability.FINANCE_EXECUTE)
  @ApiOperation({
    summary: 'Arbitrer la remise d’un retrait (ADMIN, motif obligatoire)',
  })
  async arbitrate(
    @Param('id') id: string,
    @Body() dto: ArbitratePickupDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    const order = await this.orders.arbitratePickup(id, fbUser.uid, {
      reason: dto.reason,
      ...(dto.note?.trim() ? { note: dto.note.trim() } : {}),
    });
    return {
      data: {
        id: order.id,
        status: order.status,
        deliveryProof: order.deliveryProof,
      },
    };
  }
}
