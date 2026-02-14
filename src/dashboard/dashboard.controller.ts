import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RolesGuard } from 'src/firebase/roles.guard';
import { Roles } from 'src/firebase/roles.decorator';

@Controller('dashboard')
@UseGuards(FirebaseAuthGuard, RolesGuard)
@Roles('RESTAURATEUR', 'ADMIN')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * GET /dashboard/overview
   * Récupère les statistiques générales du restaurant
   */
  @Get('overview')
  getOverview(@Req() req) {
    return this.dashboardService.getOverview(req.user.uid);
  }

  /**
   * GET /dashboard/orders
   * Récupère les statistiques des commandes par statut
   * Paramètres: period (today, week, month, year)
   */
  @Get('orders')
  getOrderStats(@Req() req, @Query('period') period?: string) {
    return this.dashboardService.getOrderStats(req.user.uid, period);
  }

  /**
   * GET /dashboard/top-products
   * Récupère les produits les plus vendus
   * Paramètres: limit (default 10), period (today, week, month, year)
   */
  @Get('top-products')
  getTopProducts(
    @Req() req,
    @Query('limit') limit?: string,
    @Query('period') period?: string,
  ) {
    return this.dashboardService.getTopProducts(
      req.user.uid,
      limit ? parseInt(limit, 10) : 10,
      period,
    );
  }

  /**
   * GET /dashboard/revenue-chart
   * Récupère l'évolution des revenus par jour
   * Paramètres: days (default 30)
   */
  @Get('revenue-chart')
  getRevenueChart(@Req() req, @Query('days') days?: string) {
    return this.dashboardService.getRevenueChart(
      req.user.uid,
      days ? parseInt(days, 10) : 30,
    );
  }

  /**
   * GET /dashboard/clients
   * Récupère les statistiques des clients
   */
  @Get('clients')
  getClientStats(@Req() req) {
    return this.dashboardService.getClientStats(req.user.uid);
  }

  /**
   * GET /dashboard/peak-hours
   * Récupère les heures de pointe
   * Paramètres: period (today, week, month, year)
   */
  @Get('peak-hours')
  getPeakHours(@Req() req, @Query('period') period?: string) {
    return this.dashboardService.getPeakHours(req.user.uid, period);
  }

  /**
   * GET /dashboard/restaurant-ranking
   * Classement des restaurants par revenu (ADMIN uniquement)
   * Paramètres: period (today, week, month, year)
   */
  @Get('restaurant-ranking')
  @Roles('ADMIN')
  getRestaurantRanking(@Query('period') period?: string) {
    return this.dashboardService.getRestaurantRanking(period);
  }
}
