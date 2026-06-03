// tracking/tracking.gateway.ts
import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { FirebaseService } from '../firebase/firebase.service';

@WebSocketGateway({
  namespace: '/tracking',
  // Aligné sur la liste blanche HTTP. Les apps mobiles (Socket.io natif)
  // n'envoient pas d'Origin → non bloquées ; seuls les navigateurs sont filtrés.
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : true,
    credentials: true,
  },
  transports: ['websocket', 'polling'], // polling = fallback réseau faible Congo
  pingInterval: 10000,
  pingTimeout: 5000,
})
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(TrackingGateway.name);

  constructor(
    private readonly tracking: TrackingService,
    private readonly firebase: FirebaseService,
  ) {}

  // ─── Connexion ─────────────────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string;
      if (!token) { client.disconnect(); return; }

      const decoded = await this.firebase.getAuth().verifyIdToken(token);
      client.data.uid = decoded.uid;
      this.logger.log(`Connecté uid=${decoded.uid}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Déconnecté uid=${client.data.uid}`);
  }

  // ─── Événements ────────────────────────────────────────────────────────────

  /**
   * CLIENT rejoint la room de sa commande.
   * Reçoit immédiatement la dernière position connue du livreur.
   */
  @SubscribeMessage('order:watch')
  async onWatchOrder(client: Socket, payload: { orderId: string }) {
    await this.tracking.assertCanWatchOrder(payload.orderId, client.data.uid);
    await client.join(`order:${payload.orderId}`);

    const lastPos = await this.tracking.getLastPosition(payload.orderId);
    if (lastPos) client.emit('driver:position', lastPos);
  }

  /**
   * LIVREUR envoie sa position toutes les 5 secondes.
   * → stocke dans Redis GEO
   * → broadcast à tous les clients de la room
   */
  @SubscribeMessage('driver:position')
  async onDriverPosition(
    client: Socket,
    payload: { orderId: string; lat: number; lng: number; accuracy?: number },
  ) {
    const { orderId, lat, lng, accuracy } = payload;

    await this.tracking.assertCanUpdatePosition(orderId, client.data.uid);
    await this.tracking.updatePosition({
      orderId,
      driverId: client.data.uid,
      lat, lng, accuracy,
    });

    const eta = await this.tracking.calculateETA(orderId, lat, lng);

    // Broadcast à tous les clients qui regardent cette commande
    // Le Redis Adapter s'occupe de router vers toutes les instances
    this.server.to(`order:${orderId}`).emit('driver:position', {
      lat, lng, eta,
      timestamp: Date.now(),
    });
  }

  /**
   * Appelé par OrdersListener quand le statut commande change.
   * Notifie le client sans qu'il ait besoin de poll.
   */
  broadcastOrderStatus(orderId: string, status: string) {
    this.server.to(`order:${orderId}`).emit('order:status', { status });
  }
}
