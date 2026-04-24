// promo/promo.controller.ts
import {
  Body, Controller, Get, HttpCode,
  HttpStatus, Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';
import { PromoService } from './promo.service';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '@prisma/client';

@ApiTags('Promo')
@ApiBearerAuth()
@Controller('promo')
export class PromoController {
  constructor(private readonly promoService: PromoService) {}

  /**
   * Valide un code avant la commande.
   * Appelé depuis l'écran checkout de l'app mobile.
   */
  @Post('validate')
  @Roles('CLIENT', 'RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Valider un code promo au checkout' })
  validate(
    @CurrentUser() user: User,
    @Body() body: {
      code: string;
      restaurantId: string;
      subTotal: number;
      deliveryFee: number;
    },
  ) {
    return this.promoService.validateCode(
      body.code,
      user.id,
      body.restaurantId,
      body.subTotal,
      body.deliveryFee,
    );
  }

  // ─── Admin ────────────────────────────────────────────────────────────────

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Créer un code promo (admin)' })
  create(@Body() dto: CreatePromoCodeDto) {
    return this.promoService.create(dto);
  }

  @Get()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Lister tous les codes promos' })
  findAll(@Query('activeOnly') activeOnly?: string) {
    return this.promoService.findAll(activeOnly === 'true');
  }

  @Patch(':id/toggle')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activer / désactiver un code promo' })
  toggle(@Param('id') id: string) {
    return this.promoService.toggle(id);
  }

  @Get(':id/stats')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Statistiques d\'utilisation d\'un code' })
  stats(@Param('id') id: string) {
    return this.promoService.getStats(id);
  }
}