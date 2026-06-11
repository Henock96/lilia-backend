/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DashboardSalesStatsService } from './dashboard-sales-stats.service';
import { DashboardClientsStatsService } from './dashboard-clients-stats.service';
import { DashboardCatalogStatsService } from './dashboard-catalog-stats.service';

/**
 * Façade dashboard (LIL-142).
 *
 * Conserve l'API publique historique consommée par DashboardController et
 * délègue aux services de stats par domaine analytique :
 *  - ventes    → DashboardSalesStatsService
 *  - clients   → DashboardClientsStatsService
 *  - catalogue → DashboardCatalogStatsService
 *
 * Les helpers partagés (périmètre restaurant/admin, filtre de période) vivent
 * dans DashboardCommonService.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly sales: DashboardSalesStatsService,
    private readonly clients: DashboardClientsStatsService,
    private readonly catalog: DashboardCatalogStatsService,
  ) {}

  // ─── Ventes ────────────────────────────────────────────────────────────────

  getOverview(firebaseUid: string) {
    return this.sales.getOverview(firebaseUid);
  }

  getOrderStats(firebaseUid: string, period?: string) {
    return this.sales.getOrderStats(firebaseUid, period);
  }

  getRevenueChart(firebaseUid: string, days = 30) {
    return this.sales.getRevenueChart(firebaseUid, days);
  }

  getPeakHours(firebaseUid: string, period?: string) {
    return this.sales.getPeakHours(firebaseUid, period);
  }

  getRestaurantRanking(period?: string) {
    return this.sales.getRestaurantRanking(period);
  }

  // ─── Clients ───────────────────────────────────────────────────────────────

  getClientStats(firebaseUid: string) {
    return this.clients.getClientStats(firebaseUid);
  }

  getClientDetail(firebaseUid: string, clientId: string) {
    return this.clients.getClientDetail(firebaseUid, clientId);
  }

  // ─── Catalogue ─────────────────────────────────────────────────────────────

  getTopProducts(firebaseUid: string, limit = 10, period?: string) {
    return this.catalog.getTopProducts(firebaseUid, limit, period);
  }

  getVendorStats() {
    return this.catalog.getVendorStats();
  }
}
