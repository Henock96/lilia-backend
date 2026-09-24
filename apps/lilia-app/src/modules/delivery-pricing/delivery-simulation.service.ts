import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { PAID_ORDER_STATUSES } from '../orders/order-status-groups';
import { DeliverySubsidyPolicy } from './delivery-pricing.engine';
import {
  priceMatrix,
  replayTariff,
  simulateSubsidy,
} from './delivery-simulation';

/** Fenêtre rejouée par les deux simulateurs. */
const WINDOW_DAYS = 30;
/** « Sur vos 30 dernières commandes » (blueprint F3-02 §2). */
const SUBSIDY_SAMPLE = 30;

/**
 * Lecture seule : charge ce qu'il faut aux simulations pures de
 * `delivery-simulation.ts`, en un nombre fixe de requêtes (jamais une par
 * commande ni une par quartier).
 */
@Injectable()
export class DeliverySimulationService {
  constructor(private readonly prisma: PrismaService) {}

  /** `POST /admin/delivery-tariffs/:id/simulate`. */
  async simulateTariff(tariffId: string) {
    const tariff = await this.prisma.deliveryTariff.findUnique({
      where: { id: tariffId },
      select: {
        version: true,
        roadFactor: true,
        bands: { select: { maxKm: true, feeXaf: true } },
        overrides: {
          select: {
            originQuartierId: true,
            destQuartierId: true,
            feeXaf: true,
          },
        },
      },
    });
    if (!tariff) throw new NotFoundException('Grille introuvable.');

    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
    const [quartiers, vendors, orders] = await Promise.all([
      this.prisma.quartier.findMany({
        select: { id: true, nom: true, latitude: true, longitude: true },
        orderBy: { nom: 'asc' },
      }),
      this.prisma.restaurant.findMany({
        where: PUBLIC_VENDOR_WHERE,
        select: {
          id: true,
          nom: true,
          quartierId: true,
          latitude: true,
          longitude: true,
        },
        orderBy: { nom: 'asc' },
      }),
      this.prisma.order.findMany({
        where: {
          isDelivery: true,
          createdAt: { gte: since },
          status: { in: [...PAID_ORDER_STATUSES] },
        },
        select: {
          deliveryQuartierId: true,
          deliveryLatitude: true,
          deliveryLongitude: true,
          deliveryFeeBaseXaf: true,
          deliveryFeeGross: true,
          restaurant: {
            select: { quartierId: true, latitude: true, longitude: true },
          },
        },
      }),
    ]);

    const centroids = new Map(quartiers.map((q) => [q.id, q]));
    return {
      version: tariff.version,
      windowDays: WINDOW_DAYS,
      replay: replayTariff(
        tariff,
        orders.map((o) => ({
          vendor: o.restaurant,
          destination: {
            quartierId: o.deliveryQuartierId,
            latitude: o.deliveryLatitude,
            longitude: o.deliveryLongitude,
          },
          historicalBaseXaf: o.deliveryFeeBaseXaf ?? o.deliveryFeeGross,
        })),
        centroids,
      ),
      matrix: priceMatrix(tariff, vendors, quartiers),
    };
  }

  /** `GET /vendors/:id/delivery-subsidy/simulate`. */
  async simulateVendorSubsidy(
    restaurantId: string,
    policy: DeliverySubsidyPolicy,
  ) {
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId,
        isDelivery: true,
        status: { in: [...PAID_ORDER_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
      take: SUBSIDY_SAMPLE,
      select: {
        subTotal: true,
        deliveryFeeBaseXaf: true,
        deliveryFeeGross: true,
      },
    });
    return simulateSubsidy(
      policy,
      orders.map((o) => ({
        baseFeeXaf: o.deliveryFeeBaseXaf ?? o.deliveryFeeGross,
        subTotalXaf: o.subTotal,
      })),
    );
  }
}
