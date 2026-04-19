// tracking/tracking.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import Redis from 'ioredis';

export interface PositionPayload {
  orderId: string;
  driverId: string;
  lat: number;
  lng: number;
  accuracy?: number;
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);
  private readonly redis: Redis;

  // TTL position : 5 minutes sans update → livreur considéré déconnecté
  private readonly POSITION_TTL = 300;
  // Persist en DB toutes les 60 secondes seulement — évite le flood
  private readonly PERSIST_INTERVAL = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.redis = new Redis(this.config.get('REDIS_URL'));
  }

  async updatePosition(payload: PositionPayload): Promise<void> {
    const { orderId, driverId, lat, lng, accuracy } = payload;

    // 1. Redis GEO — position instantanée, lecture < 1ms
    await this.redis.geoadd('driver_positions', lng, lat, driverId);

    // 2. Métadonnées avec TTL — effacé si livreur déconnecté 5min
    await this.redis.setex(
      `delivery:${orderId}`,
      this.POSITION_TTL,
      JSON.stringify({ lat, lng, accuracy, ts: Date.now() }),
    );

    // 3. Persist PostgreSQL — seulement si 60s écoulées (clé NX = "si n'existe pas")
    // Redis pose un verrou de 60s → 1 seul write DB par minute max
    const shouldPersist = await this.redis.set(
      `persist_lock:${orderId}`,
      '1',
      'EX', this.PERSIST_INTERVAL,
      'NX', // Only if Not eXists
    );

    if (shouldPersist === 'OK') {
      // Fire-and-forget — n'attend pas la DB pour répondre au livreur
      this.persistPosition(orderId, lat, lng, accuracy).catch((err) =>
        this.logger.error(`Persist échoué livraison ${orderId} : ${err.message}`),
      );
    }
  }

  private async persistPosition(
    deliveryId: string,
    latitude: number,
    longitude: number,
    accuracy?: number,
  ): Promise<void> {
    await this.prisma.deliveryLocation.create({
      data: { deliveryId, latitude, longitude, accuracy },
    });
  }

  async getLastPosition(orderId: string) {
    const raw = await this.redis.get(`delivery:${orderId}`);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * ETA Haversine — calcul local, zéro appel API.
   * Vitesse moyenne Brazzaville : 25 km/h.
   * Si tu veux du trafic réel un jour → remplace par Google Directions API.
   */
  async calculateETA(
    orderId: string,
    driverLat: number,
    driverLng: number,
  ): Promise<number> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { deliveryLatitude: true, deliveryLongitude: true },
    });

    if (!order?.deliveryLatitude || !order?.deliveryLongitude) return 0;

    const km = this.haversine(
      driverLat, driverLng,
      order.deliveryLatitude, order.deliveryLongitude,
    );

    return Math.ceil((km / 25) * 60); // minutes
  }

  private haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
