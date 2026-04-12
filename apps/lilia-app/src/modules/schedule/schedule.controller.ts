/* eslint-disable prettier/prettier */
// schedule/schedule.controller.ts
import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RestaurantScheduleService } from './restaurant-schedule.service';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Admin — Scheduler')
@ApiBearerAuth()
@Controller('admin/schedule')
@Roles('ADMIN')
export class ScheduleController {
  constructor(private readonly scheduleService: RestaurantScheduleService) {}

  /**
   * Déclenche manuellement le check des horaires restaurants.
   * Utile après un changement d'horaires pour ne pas attendre le prochain cron.
   */
  @Post('check-hours')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Forcer la vérification des horaires restaurants' })
  checkHours() {
    return this.scheduleService.handleScheduleCheck();
  }

  /**
   * Déclenche manuellement le reset du stock quotidien.
   * Utile en cas de problème avec le cron de minuit.
   */
  @Post('reset-stock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Forcer le reset du stock quotidien' })
  resetStock() {
    return this.scheduleService.handleDailyStockReset();
  }
}
