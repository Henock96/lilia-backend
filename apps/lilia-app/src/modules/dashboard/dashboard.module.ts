/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardCommonService } from './dashboard-common.service';
import { DashboardSalesStatsService } from './dashboard-sales-stats.service';
import { DashboardClientsStatsService } from './dashboard-clients-stats.service';
import { DashboardCatalogStatsService } from './dashboard-catalog-stats.service';
import { DashboardController } from './dashboard.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [
    DashboardService,
    DashboardCommonService,
    DashboardSalesStatsService,
    DashboardClientsStatsService,
    DashboardCatalogStatsService,
  ],
  controllers: [DashboardController],
  exports: [DashboardService],
})
export class DashboardModule {}
