// tracking/tracking.service.ts
import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
  private readonly redis: Redis | null;

  // TTL position : 5 minutes sans update → livreur considéré déconnecté
  private readonly POSITION_TTL = 300;
  // Persist en DB toutes les 60 secondes seulement — évite le flood
  private readonly PERSIST_INTERVAL = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const redisUrl = this.config.get<string>('REDIS_URL');
    this.redis = redisUrl ? new Redis(redisUrl) : null;
    if (!redisUrl) {
      this.logger.warn('REDIS_URL non défini: tracking temps réel indisponible');
    }
  }

  async updatePosition(payload: PositionPayload): Promise<void> {
    const { orderId, driverId, lat, lng, accuracy } = payload;
    const redis = this.getRedis();

    // 1. Redis GEO — position instantanée, lecture < 1ms
    await redis.geoadd('driver_positions', lng, lat, driverId);

    // 2. Métadonnées avec TTL — effacé si livreur déconnecté 5min
    await redis.setex(
      `delivery:${orderId}`,
      this.POSITION_TTL,
      JSON.stringify({ lat, lng, accuracy, ts: Date.now() }),
    );

    // 3. Persist PostgreSQL — seulement si 60s écoulées (clé NX = "si n'existe pas")
    // Redis pose un verrou de 60s → 1 seul write DB par minute max
    const shouldPersist = await redis.set(
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
    orderId: string,
    latitude: number,
    longitude: number,
    accuracy?: number,
  ): Promise<void> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
      select: { id: true },
    });

    if (!delivery) {
      this.logger.warn(`Position ignorée: aucune livraison pour la commande ${orderId}`);
      return;
    }

    await this.prisma.deliveryLocation.create({
      data: { deliveryId: delivery.id, latitude, longitude, accuracy },
    });
    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        lastLatitude: latitude,
        lastLongitude: longitude,
        lastPositionAt: new Date(),
      },
    });
  }

  async getLastPosition(orderId: string) {
    const redis = this.getRedis();
    const raw = await redis.get(`delivery:${orderId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async assertCanWatchOrder(orderId: string, firebaseUid: string): Promise<void> {
    const { user, order } = await this.getUserAndOrder(orderId, firebaseUid);

    if (
      user.role === 'ADMIN' ||
      order.userId === user.id ||
      order.restaurant.ownerId === user.id ||
      order.delivery?.delivererId === user.id
    ) {
      return;
    }

    throw new ForbiddenException('Accès tracking refusé pour cette commande');
  }

  async assertCanUpdatePosition(orderId: string, firebaseUid: string): Promise<void> {
    const { user, order } = await this.getUserAndOrder(orderId, firebaseUid);

    if (user.role === 'ADMIN') return;
    if (user.role !== 'LIVREUR' || order.delivery?.delivererId !== user.id) {
      throw new ForbiddenException('Seul le livreur assigné peut publier sa position');
    }
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

  private getRedis(): Redis {
    if (!this.redis) {
      throw new ServiceUnavailableException('Tracking Redis non configuré');
    }
    return this.redis;
  }

  private async getUserAndOrder(orderId: string, firebaseUid: string) {
    const [user, order] = await Promise.all([
      this.prisma.user.findUnique({ where: { firebaseUid } }),
      this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          restaurant: { select: { ownerId: true } },
          delivery: { select: { delivererId: true } },
        },
      }),
    ]);

    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    if (!order) throw new NotFoundException('Commande introuvable');
    return { user, order };
  }
}
