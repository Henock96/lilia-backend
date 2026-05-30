/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { DecodedIdToken } from 'firebase-admin/auth';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
@Roles('RESTAURATEUR', 'ADMIN')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * GET /dashboard/overview
   * Récupère les statistiques générales du restaurant
   */
  @Get('overview')
  @ApiOperation({ summary: 'Vue générale : commandes, CA, clients, note' })
  getOverview(@FirebaseUser() fbUser: DecodedIdToken) {
    return this.dashboardService.getOverview(fbUser.uid);
  }

  /**
   * GET /dashboard/orders
   * Récupère les statistiques des commandes par statut
   * Paramètres: period (today, week, month, year)
   */
  @Get('orders')
  @ApiOperation({ summary: 'Commandes par statut' })
  @ApiQuery({ name: 'period', required: false, enum: ['today', 'week', 'month', 'year'] })
  getOrderStats(
    @FirebaseUser() fbUser: DecodedIdToken, 
    @Query('period') period?: string
  ) {
    return this.dashboardService.getOrderStats(fbUser.uid, period);
  }

  /**
   * GET /dashboard/top-products
   * Récupère les produits les plus vendus
   * Paramètres: limit (default 10), period (today, week, month, year)
   */
  @Get('top-products')
  getTopProducts(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query('limit') limit?: string,
    @Query('period') period?: string,
  ) {
    return this.dashboardService.getTopProducts(
      fbUser.uid,
      limit ? parseInt(limit, 10) : undefined,
      period,
    );
  }

  /**
   * GET /dashboard/revenue-chart
   * Récupère l'évolution des revenus par jour
   * Paramètres: days (default 30)
   */
  @Get('revenue-chart')
  @ApiOperation({ summary: 'Évolution CA sur N jours' })
  @ApiQuery({ name: 'days', required: false })
  getRevenueChart(
    @FirebaseUser() fbUser: DecodedIdToken, 
    @Query('days') days = '30',
    ) {
    return this.dashboardService.getRevenueChart(
      fbUser.uid,
      parseInt(days, 10)
    );
  }

  /**
   * GET /dashboard/clients
   * Récupère les statistiques des clients
   */
  @Get('clients')
  @ApiOperation({ summary: 'Stats clients : nouveaux, fidèles, top dépensiers' })
  getClientStats(@FirebaseUser() fbUser: DecodedIdToken) {
    return this.dashboardService.getClientStats(fbUser.uid);
  }

  @Get('clients/:clientId')
  @ApiOperation({ summary: 'Détail complet d\'un client (commandes, dépenses, adresses)' })
  getClientDetail(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Param('clientId') clientId: string,
  ) {
    return this.dashboardService.getClientDetail(fbUser.uid, clientId);
  }

  /**
   * GET /dashboard/peak-hours
   * Récupère les heures de pointe
   * Paramètres: period (today, week, month, year)
   */
  @Get('peak-hours')
  @ApiOperation({ summary: 'Heures de pointe' })
  getPeakHours(@FirebaseUser() fbUser: DecodedIdToken, @Query('period') period?: string) {
    return this.dashboardService.getPeakHours(fbUser.uid, period);
  }

  /**
   * GET /dashboard/restaurant-ranking
   * Classement des restaurants par revenu (ADMIN uniquement)
   * Paramètres: period (today, week, month, year)
   */
  @Get('restaurant-ranking')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Classement des restaurants par CA (admin)' })
  @ApiQuery({ name: 'period', required: false })
  getRestaurantRanking(@Query('period') period?: string) {
    return this.dashboardService.getRestaurantRanking(period);
  }

  /**
   * GET /dashboard/vendors
   * Statistiques marketplace (ADMIN) : total, en attente, par type.
   */
  @Get('vendors')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Stats vendeurs : total, en attente de validation, par type',
  })
  getVendorStats() {
    return this.dashboardService.getVendorStats();
  }
}
