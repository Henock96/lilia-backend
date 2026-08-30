// tracking/tracking.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { FirebaseService } from '../firebase/firebase.service';
import { UserCacheService } from '../auth/services/user-cache.service';
import { DriverPositionDto, WatchOrderDto } from './dto/driver-position.dto';
import { accessRevocationReason } from '../auth/utils/account-access';

/**
 * `main.ts` n'applique son `useGlobalPipes` qu'au transport HTTP. Les gateways
 * WS doivent donc déclarer leur propre pipe — et convertir les erreurs en
 * `WsException`, sinon Nest ne sait pas les rendre au client Socket.io.
 */
const wsValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: (errors) =>
    new WsException(
      errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .join(' | ') || 'Payload invalide',
    ),
});

@WebSocketGateway({
  namespace: '/tracking',
  // Aligné sur la liste blanche HTTP. Les apps mobiles (Socket.io natif)
  // n'envoient pas d'Origin → non bloquées ; seuls les navigateurs sont filtrés.
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      : true,
    credentials: true,
  },
  transports: ['websocket', 'polling'], // polling = fallback réseau faible Congo
  pingInterval: 10000,
  pingTimeout: 5000,
})
export class TrackingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(TrackingGateway.name);

  constructor(
    private readonly tracking: TrackingService,
    private readonly firebase: FirebaseService,
    private readonly userCache: UserCacheService,
  ) {}

  // ─── Connexion ─────────────────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string;
      if (!token) {
        client.disconnect();
        return;
      }

      const decoded = await this.firebase.getAuth().verifyIdToken(token);
      client.data.uid = decoded.uid;
      // `exp` (secondes epoch) sert à revalider la session à chaque message :
      // un ID token Firebase expire au bout d'1h, mais une socket peut rester
      // ouverte bien plus longtemps.
      client.data.tokenExp = decoded.exp;
      this.logger.log(`Connecté uid=${decoded.uid}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Déconnecté uid=${client.data.uid}`);
  }

  /**
   * Revalide la session à chaque message reçu.
   *
   * Le token n'était vérifié qu'au `handleConnection` : un livreur banni ou
   * désactivé gardait l'accès au flux de tracking tant qu'il ne se déconnectait
   * pas — alors que le chemin HTTP, lui, le rejette (`RolesGuard`). On aligne
   * les deux, et on déconnecte plutôt que de répondre en erreur : le client
   * Socket.io se reconnectera avec un token frais.
   */
  private async assertSessionStillValid(client: Socket): Promise<void> {
    const exp = client.data.tokenExp as number | undefined;
    if (!exp || Date.now() / 1000 >= exp) {
      client.disconnect();
      throw new WsException('Session expirée, reconnectez-vous.');
    }

    const user = await this.userCache.getByFirebaseUid(client.data.uid);
    const revoked = user
      ? accessRevocationReason(user.statusUser)
      : 'Compte introuvable.';
    if (revoked) {
      this.logger.warn(
        `Socket rejetée — compte inactif/bloqué/supprimé uid=${client.data.uid}`,
      );
      client.disconnect();
      throw new WsException(revoked);
    }
  }

  // ─── Événements ────────────────────────────────────────────────────────────

  /**
   * CLIENT rejoint la room de sa commande.
   * Reçoit immédiatement la dernière position connue du livreur.
   */
  @SubscribeMessage('order:watch')
  @UsePipes(wsValidationPipe)
  async onWatchOrder(client: Socket, @MessageBody() payload: WatchOrderDto) {
    await this.assertSessionStillValid(client);
    await this.tracking.assertCanWatchOrder(payload.orderId, client.data.uid);
    await client.join(`order:${payload.orderId}`);

    const lastPos = await this.tracking.getLastPosition(payload.orderId);
    // `orderId` explicite : une même socket peut watcher plusieurs commandes
    // (admin), le client ne doit pas déduire la provenance de la room.
    if (lastPos) {
      client.emit('driver:position', { orderId: payload.orderId, ...lastPos });
    }
  }

  /**
   * LIVREUR envoie sa position toutes les 5 secondes.
   * → stocke dans Redis GEO
   * → broadcast à tous les clients de la room
   */
  @SubscribeMessage('driver:position')
  @UsePipes(wsValidationPipe)
  async onDriverPosition(
    client: Socket,
    @MessageBody() payload: DriverPositionDto,
  ) {
    const { orderId, lat, lng, accuracy } = payload;

    await this.assertSessionStillValid(client);
    await this.tracking.assertCanUpdatePosition(orderId, client.data.uid);
    await this.tracking.updatePosition({
      orderId,
      driverId: client.data.uid,
      lat,
      lng,
      accuracy,
    });

    const eta = await this.tracking.calculateETA(orderId, lat, lng);

    this.broadcastDriverPosition(orderId, { lat, lng, eta });
  }

  /**
   * Broadcast d'une position à tous les clients qui regardent la commande.
   * Le Redis Adapter s'occupe de router vers toutes les instances.
   *
   * Point d'entrée unique des trois émetteurs (`driver:position` WS,
   * `POST /tracking/position[/batch]`, `PATCH /deliveries/:id/location`) :
   * c'est ce qui garantit qu'`orderId` est toujours dans le payload, plutôt
   * que de dépendre de quatre `emit()` dispersés restant alignés.
   *
   * `server` est optionnel : la gateway est injectée dans des services testés
   * sans serveur Socket.io attaché.
   */
  broadcastDriverPosition(
    orderId: string,
    payload: { lat: number; lng: number; eta: number; source?: string },
  ) {
    this.server?.to(`order:${orderId}`)?.emit('driver:position', {
      orderId,
      lat: payload.lat,
      lng: payload.lng,
      eta: payload.eta,
      timestamp: Date.now(),
      ...(payload.source ? { source: payload.source } : {}),
    });
  }

  /**
   * Appelé par OrdersListener quand le statut commande change.
   * Notifie le client sans qu'il ait besoin de poll.
   */
  broadcastOrderStatus(orderId: string, status: string) {
    this.server?.to(`order:${orderId}`)?.emit('order:status', {
      orderId,
      status,
      timestamp: Date.now(),
    });
  }
}
