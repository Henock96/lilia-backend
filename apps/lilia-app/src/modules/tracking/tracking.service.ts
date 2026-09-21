// tracking/tracking.service.ts
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import Redis from 'ioredis';
import { buildRedisOptions } from '../../common/redis/redis-options';

export interface PositionPayload {
  orderId: string;
  driverId: string;
  lat: number;
  lng: number;
  accuracy?: number;
}

@Injectable()
export class TrackingService implements OnModuleDestroy {
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
    // Connexion dédiée, volontairement distincte du client partagé : le
    // tracking émet une rafale toutes les 5 s par livreur et doit pouvoir
    // saturer ou tomber sans entraîner le checkout avec lui. Ses options
    // viennent de `common/redis/redis-options.ts` — sans `commandTimeout`, une
    // position perdue bloquait le handler au lieu d'être simplement remplacée
    // cinq secondes plus tard.
    this.redis = redisUrl
      ? new Redis(redisUrl, buildRedisOptions({ usage: 'tracking', config }))
      : null;
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL non défini: tracking temps réel indisponible',
      );
    }
    // OBLIGATOIRE : ioredis étend EventEmitter et émet 'error' à chaque coupure
    // réseau. Un 'error' sans listener fait planter le process Node — sur Render,
    // un simple redémarrage de l'instance Redis suffirait à tuer l'API entière.
    // ioredis se reconnecte tout seul : on log, on ne relance pas.
    this.redis?.on('error', (err) =>
      this.logger.error(`Redis (tracking) indisponible: ${err.message}`),
    );
  }

  /**
   * Ferme proprement la connexion à l'arrêt du module — sans ça, le socket reste
   * ouvert et Render tue le process au timeout de shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  /**
   * Écrit la position "live" dans Redis : métadonnées à TTL
   * (`delivery:{orderId}`). C'est la SOURCE DE VÉRITÉ temps réel, partagée
   * par les deux paths d'update :
   *   - WS    : POST /tracking/position  → updatePosition (ci-dessous)
   *   - HTTP  : PATCH /deliveries/:id/location → DeliveriesService.updateLocation
   * Best-effort : no-op silencieux si Redis n'est pas configuré (cf. LIL-54,
   * doc docs/01-architecture/delivery-tracking.md).
   */
  async cacheLivePosition(payload: PositionPayload): Promise<void> {
    if (!this.redis) return;
    // Un seul aller-retour au lieu de deux : les deux écritures sont
    // indépendantes, rien n'obligeait à attendre la première pour émettre la
    // seconde.
    const results = await this.queueLivePosition(
      this.redis.pipeline(),
      payload,
    ).exec();
    this.assertPipelineSucceeded(results);
  }

  /**
   * Empile les deux écritures de position sur un pipeline, sans l'exécuter.
   *
   * Partagé entre `cacheLivePosition` (repli HTTP `PATCH /deliveries/:id/location`)
   * et `updatePosition` (voie WebSocket), pour que les deux chemins écrivent
   * exactement la même chose — et pour que le second puisse y ajouter son verrou
   * et tout envoyer d'un coup.
   */
  private queueLivePosition(
    pipeline: ReturnType<Redis['pipeline']>,
    { orderId, lat, lng, accuracy }: PositionPayload,
  ): ReturnType<Redis['pipeline']> {
    // ⚠️ `GEOADD driver_positions` a été **retiré** le 21/09/2026.
    //
    // Il était écrit ici toutes les 5 secondes par livreur en course, et
    // **jamais lu** : un balayage du dépôt ne trouve aucun `GEOPOS`,
    // `GEORADIUS` ni `GEOSEARCH`. Un ensemble trié Redis n'a pas de TTL par
    // membre, et rien ne l'émondait — les coordonnées d'un livreur y
    // survivaient donc à sa déconnexion, à sa sortie de la plateforme et à la
    // suppression de son compte par `UserDeletionService`, indexées par son
    // UID Firebase. `TRACKING_RETENTION_DAYS`, qui purge `DeliveryLocation` en
    // base, ne le touchait pas non plus.
    //
    // Une structure écrite sans jamais être lue n'est pas une fondation pour
    // plus tard : c'est une rétention de données de déplacement que rien ne
    // borne, doublée d'une commande réseau par position. Le jour où « trouver
    // le livreur le plus proche » sera construit, le `GEOADD` reviendra — avec
    // son lecteur et son émondage, c'est-à-dire vérifiable.
    //
    // La position vivante reste `delivery:{orderId}`, qui porte un TTL.
    return pipeline.setex(
      `delivery:${orderId}`,
      this.POSITION_TTL,
      JSON.stringify({ lat, lng, accuracy, ts: Date.now() }),
    );
  }

  async updatePosition(payload: PositionPayload): Promise<void> {
    const { orderId, lat, lng, accuracy } = payload;
    const redis = this.getRedis();

    // Les deux commandes en un seul aller-retour.
    //
    // Elles étaient enchaînées par des `await` successifs alors qu'aucune ne
    // dépend du résultat de la précédente. Avec un Redis distant, cela coûtait
    // autant de fois le temps de trajet — sur un message émis toutes les
    // 5 secondes par livreur en course.
    //
    // Même TTL (300 s), même intervalle de persistance (60 s), même sémantique
    // de verrou `NX`.
    //
    // ⚠️ **L'indice compte** : c'est la position dans le pipeline qui désigne
    // le résultat lu, et la suppression du `GEOADD` (mort, cf.
    // `queueLivePosition`) a décalé tout ce qui suit. Un indice figé en dur
    // aurait fait lire le résultat du `SETEX` comme un verrou — c'est-à-dire
    // persister à chaque position au lieu d'une fois par minute, sans qu'aucun
    // test ne le voie si l'on n'en écrit pas un.
    //   [0] SETEX   [1] SET NX EX ← le seul résultat qu'on lit
    const PERSIST_LOCK_INDEX = 1;

    const results = await this.queueLivePosition(redis.pipeline(), payload)
      .set(
        `persist_lock:${orderId}`,
        '1',
        'EX',
        this.PERSIST_INTERVAL,
        'NX', // Only if Not eXists
      )
      .exec();

    // `exec()` ne rejette pas sur l'échec d'une commande : il rend un couple
    // `[erreur, résultat]` par commande. Sans ce contrôle, une erreur Redis
    // deviendrait silencieuse — alors que les trois `await` d'avant la
    // propageaient. On relance donc la première, à l'identique.
    this.assertPipelineSucceeded(results);

    const shouldPersist = results?.[PERSIST_LOCK_INDEX]?.[1];

    if (shouldPersist === 'OK') {
      // Fire-and-forget — n'attend pas la DB pour répondre au livreur
      this.persistPosition(orderId, lat, lng, accuracy).catch((err) =>
        this.logger.error(
          `Persist échoué livraison ${orderId} : ${err.message}`,
        ),
      );
    }
  }

  /**
   * Relance la première erreur d'un pipeline.
   *
   * Un `pipeline().exec()` est résolu même quand une commande a échoué : les
   * erreurs sont rendues dans les couples `[erreur, résultat]`. Les trois
   * `await` d'origine, eux, rejetaient. Sans ce contrôle, la mise en pipeline
   * transformerait une panne Redis en succès silencieux — et le verrou de
   * persistance serait lu comme « déjà pris », donc aucune position n'atteindrait
   * plus jamais la base.
   */
  private assertPipelineSucceeded(
    results: [Error | null, unknown][] | null,
  ): void {
    const failure = results?.find(([err]) => err)?.[0];
    if (failure) throw failure;
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
      this.logger.warn(
        `Position ignorée: aucune livraison pour la commande ${orderId}`,
      );
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

  /**
   * Oublie la dernière position connue d'une commande.
   *
   * Appelé à la **réassignation**. Sans lui, `delivery:{orderId}` gardait la
   * position de l'ancien livreur jusqu'à son TTL (5 min) : un client ouvrant le
   * suivi dans cet intervalle recevait, dès son `order:watch`, un point figé
   * appartenant à quelqu'un qui n'est plus sur la course — et il le suivait,
   * puisque rien ne le distingue d'une position vivante.
   *
   * ⚠️ La clé est indexée **par commande**, et c'est ce qui rend cet effacement
   * sûr : l'ancien livreur peut très bien être en course ailleurs, sa position
   * sur CETTE commande est la seule chose qui devient périmée.
   * (L'ensemble GEO indexé par livreur, qui compliquait ce raisonnement, a été
   * retiré le 21/09/2026 — il n'était lu nulle part.)
   *
   * Best-effort, comme toute écriture de tracking : une panne Redis ne doit pas
   * empêcher une réassignation, qui est un geste d'exploitation.
   */
  async forgetLastPosition(orderId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(`delivery:${orderId}`);
    } catch (err) {
      this.logger.warn(
        `Position live non purgée pour ${orderId} : ${(err as Error).message}`,
      );
    }
  }

  async assertCanWatchOrder(
    orderId: string,
    firebaseUid: string,
  ): Promise<void> {
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

  async assertCanUpdatePosition(
    orderId: string,
    firebaseUid: string,
  ): Promise<void> {
    const { user, order } = await this.getUserAndOrder(orderId, firebaseUid);

    if (user.role === 'ADMIN') return;
    if (user.role !== 'LIVREUR' || order.delivery?.delivererId !== user.id) {
      throw new ForbiddenException(
        'Seul le livreur assigné peut publier sa position',
      );
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
      driverLat,
      driverLng,
      order.deliveryLatitude,
      order.deliveryLongitude,
    );

    return Math.ceil((km / 25) * 60); // minutes
  }

  private haversine(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
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
