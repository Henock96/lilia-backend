import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { WeatherService } from './weather.service';

/**
 * Météo publique de Brazzaville (accueil des apps). Donnée publique, sans
 * compte : `@Public()`. Le débit est borné par le `ThrottlerGuard` global, et
 * le cache du service limite OpenWeatherMap à un appel par demi-heure.
 */
@ApiTags('Weather')
@Controller('weather')
export class WeatherController {
  constructor(private readonly weather: WeatherService) {}

  @Public()
  @Get('brazzaville')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Météo actuelle de Brazzaville (OpenWeatherMap)' })
  async brazzaville() {
    return { data: await this.weather.getBrazzaville() };
  }
}
