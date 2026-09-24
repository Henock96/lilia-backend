import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { DeliveryTariffsService } from './delivery-tariffs.service';

/**
 * Grille de livraison en vigueur, en lecture (F3-02, écran « Livraison » du
 * vendeur). Le vendeur ne fixe plus le prix : il doit pouvoir le lire.
 */
@ApiTags('Delivery pricing')
@ApiBearerAuth()
@Controller('delivery-tariffs')
@Roles('ADMIN', 'RESTAURATEUR')
export class DeliveryTariffsController {
  constructor(
    private readonly tariffs: DeliveryTariffsService,
    private readonly settings: PlatformSettingsService,
  ) {}

  @Get('current')
  @ApiOperation({ summary: 'Mode de tarification et grille publiée' })
  async current() {
    const { deliveryPricingMode } = await this.settings.getSettings();
    return {
      data: {
        mode: deliveryPricingMode,
        tariff: await this.tariffs.current(),
      },
    };
  }
}
