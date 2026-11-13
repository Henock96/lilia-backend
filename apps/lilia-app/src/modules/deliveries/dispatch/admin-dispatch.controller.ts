import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { User } from '@prisma/client';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireSecondFactor } from '../../auth/decorators/require-second-factor.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DeliveryDispatchService } from './delivery-dispatch.service';

/**
 * Supervision du dispatch FCFS (10/11/2026).
 *
 * L'administrateur **consulte** et **relance** ; il n'attribue jamais. La
 * relance est classée `NONE` (opération courante, comme le cockpit) et
 * marquée second facteur : elle remet une course en jeu pour tous les
 * livreurs, à l'image des autres gestes d'exploitation sensibles.
 */
@ApiTags('Deliveries')
@ApiBearerAuth()
@Controller('admin/deliveries')
@Roles('ADMIN')
export class AdminDispatchController {
  constructor(private readonly dispatch: DeliveryDispatchService) {}

  @Get('dispatch')
  @ApiOperation({
    summary:
      'Recherches de livreur : ouvertes, épuisées, attribuées (24 h), échecs à relancer',
  })
  supervision() {
    return this.dispatch.supervision();
  }

  @Post(':id/redispatch')
  @HttpCode(HttpStatus.OK)
  @RequireSecondFactor()
  @ApiOperation({
    summary: 'Relancer la recherche d’une course, sans choisir de livreur',
  })
  @ApiParam({ name: 'id' })
  redispatch(@Param('id') id: string, @CurrentUser() admin: User) {
    return this.dispatch.redispatch(id, admin.id);
  }

  @Post('by-order/:orderId/redispatch')
  @HttpCode(HttpStatus.OK)
  @RequireSecondFactor()
  @ApiOperation({
    summary:
      'Relancer (ou ouvrir) la recherche d’une commande prête sans course',
  })
  @ApiParam({ name: 'orderId' })
  redispatchOrder(
    @Param('orderId') orderId: string,
    @CurrentUser() admin: User,
  ) {
    return this.dispatch.redispatchOrder(orderId, admin.id);
  }
}
