import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';
import { VendorEarningsService } from '../services/vendor-earnings.service';

/**
 * « Mes gains » (F3-07) — le vendeur voit ses versements à venir, reçus, et
 * sa dette éventuelle. Lecture seule, bornée à SES boutiques
 * (`ownerId`) : l'identifiant ne vient jamais de la requête.
 */
@ApiTags('Versements vendeur')
@ApiBearerAuth()
@Controller('vendors/me/earnings')
@Roles('RESTAURATEUR')
export class VendorEarningsController {
  constructor(private readonly earnings: VendorEarningsService) {}

  @Get()
  @ApiOperation({ summary: 'Mes gains : à venir, reçus, dette' })
  async mine(@CurrentUser() user: User, @Query() page: PaginationQueryDto) {
    return this.earnings.forOwner(user.id, page.page, page.limit);
  }
}
