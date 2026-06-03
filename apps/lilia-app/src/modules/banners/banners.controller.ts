import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';

import { BannersService } from './banners.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { ReorderBannerDto } from './dto/reorder-banner.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';

@ApiTags('Banners')
@ApiBearerAuth()
@Controller('banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  // ─── Routes publiques ──────────────────────────────────────────────────────

  @Public()
  @Get()
  @ApiOperation({ summary: 'Bannières actives (homepage ou restaurant)' })
  findAll(@Query('restaurantId') restaurantId?: string) {
    return this.bannersService.findAll(restaurantId);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Une bannière par ID' })
  findOne(@Param('id') id: string) {
    return this.bannersService.findOne(id);
  }
  // ─── Routes protégées ──────────────────────────────────────────────────────

  @Post()
  @Roles('ADMIN')
  create(
    @Body() createBannerDto: CreateBannerDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.bannersService.create(createBannerDto, fbUser.uid);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifier une bannière' })
  @Roles('ADMIN')
  update(
    @Param('id') id: string,
    @Body() updateBannerDto: UpdateBannerDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.bannersService.update(id, updateBannerDto, fbUser.uid);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer une bannière' })
  remove(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.bannersService.remove(id, fbUser.uid);
  }

  @Patch(':id/reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Changer l'ordre d'affichage" })
  @Roles('ADMIN')
  reorder(
    @Param('id') id: string,
    @Body() dto: ReorderBannerDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.bannersService.reorder(id, dto.displayOrder, fbUser.uid);
  }
}
