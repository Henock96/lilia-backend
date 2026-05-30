/* eslint-disable prettier/prettier */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';

import { VendorsService } from './vendors.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { FilterVendorsDto } from './dto/filter-vendors.dto';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/**
 * Endpoints marketplace multi-vendeurs.
 * Les routes publiques ne retournent JAMAIS un vendeur avec
 * adminApproved=false : c'est la frontière de sécurité du module.
 *
 * Ordre des routes : statiques avant `:id` (sinon NestJS interprète
 * la string comme un paramètre).
 */
@ApiTags('Vendors')
@ApiBearerAuth()
@Controller('vendors')
export class VendorsController {
  constructor(private readonly service: VendorsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liste les vendeurs approuvés (marketplace)' })
  findAll(@Query() dto: FilterVendorsDto) {
    return this.service.findAll(dto);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Détail public d\'un vendeur approuvé' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Roles('ADMIN')
  @Post()
  @ApiOperation({ summary: 'Créer un nouveau vendeur (onboarding admin)' })
  create(@Body() dto: CreateVendorDto, @CurrentUser() admin: User) {
    return this.service.createVendor(dto, admin.id);
  }

  @Roles('ADMIN')
  @Patch(':id/approve')
  @ApiOperation({ summary: 'Approuver un vendeur (BEVERAGE_SHOP surtout)' })
  approve(@Param('id') id: string, @CurrentUser() admin: User) {
    return this.service.approveVendor(id, admin.id);
  }

  @Roles('RESTAURATEUR', 'ADMIN')
  @Put(':id/profile')
  @ApiOperation({ summary: 'Mettre à jour son profil vendeur (story, certifications, etc.)' })
  updateProfile(
    @Param('id') id: string,
    @Body() dto: UpdateVendorProfileDto,
    @CurrentUser() caller: User,
  ) {
    return this.service.updateVendorProfile(id, caller, dto);
  }
}
