import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminCapability, User } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  AdminVendorOffersQueryDto,
  CreateVendorOfferDto,
  StopVendorOfferDto,
  UpdateVendorOfferDto,
} from './dto/vendor-offer.dto';
import { VendorOffersService } from './vendor-offers.service';

/**
 * « Mes offres » (F3-11) — le vendeur gère les offres de SA boutique
 * (`ownerId`) : l'identifiant du vendeur ne vient jamais de la requête.
 */
@ApiTags('Offres vendeur')
@ApiBearerAuth()
@Controller('vendors/me/offers')
@Roles('RESTAURATEUR')
export class VendorOffersController {
  constructor(private readonly offers: VendorOffersService) {}

  @Get()
  @ApiOperation({ summary: 'Mes offres, budget consommé compris' })
  list(@CurrentUser() user: User) {
    return this.offers.listMine(user.id);
  }

  @Post()
  @ApiOperation({
    summary: 'Publier une offre boutique (financée par le vendeur)',
  })
  create(@CurrentUser() user: User, @Body() dto: CreateVendorOfferDto) {
    return this.offers.create(user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Mettre en pause, reprendre ou terminer une offre' })
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateVendorOfferDto,
  ) {
    return this.offers.update(user.id, id, dto.action);
  }
}

/** Offres boutique vues par l'administration : liste et arrêt d'urgence. */
@ApiTags('Offres vendeur')
@ApiBearerAuth()
@Controller('admin/offers')
@Roles('ADMIN')
export class AdminVendorOffersController {
  constructor(private readonly offers: VendorOffersService) {}

  @Get()
  @ApiOperation({ summary: 'Toutes les offres vendeur' })
  list(@Query() query: AdminVendorOffersQueryDto) {
    return this.offers.listAll(query);
  }

  @Post(':id/stop')
  @RequireCapability(AdminCapability.SETTINGS)
  @ApiOperation({ summary: "Arrêter d'urgence une offre (motif obligatoire)" })
  stop(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: StopVendorOfferDto,
  ) {
    return this.offers.stop(user.id, id, dto.reason);
  }
}
