// promo/promo.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PromoService } from './promo.service';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { ValidatePromoDto } from './dto/validate-promo.dto';
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
  // Anti brute-force d'enumération de codes promo (CRIT-7) : 1/s + 5/min.
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Valider un code promo au checkout' })
  validate(@CurrentUser() user: User, @Body() body: ValidatePromoDto) {
    // Fix L6 : `subTotal`, `deliveryFee` et `restaurantId` du corps ne sont
    // plus lus — le montant vient du panier serveur. Les champs restent
    // acceptés (et ignorés) pour ne pas casser les clients déployés.
    return this.promoService.validateCodeForCart(body.code, user.id);
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

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un code promo (admin)' })
  remove(@Param('id') id: string) {
    return this.promoService.remove(id);
  }

  @Get(':id/stats')
  @Roles('ADMIN')
  @ApiOperation({ summary: "Statistiques d'utilisation d'un code" })
  stats(@Param('id') id: string) {
    return this.promoService.getStats(id);
  }
}
