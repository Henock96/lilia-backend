// tracking/tracking.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { DecodedIdToken } from 'firebase-admin/auth';
import { TrackingService } from './tracking.service';
import { TrackingGateway } from './tracking.gateway';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Fallback HTTP quand le WebSocket est impossible (réseau très faible).
 * Le livreur fait un POST toutes les 15s au lieu de push WS toutes les 5s.
 */
@Controller('tracking')
export class TrackingController {
  constructor(
    private readonly trackingService: TrackingService,
    private readonly gateway: TrackingGateway,
  ) {}

  @Post('position')
  @Roles('LIVREUR')
  @HttpCode(HttpStatus.OK)
  async updatePosition(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body() body: { orderId: string; lat: number; lng: number; accuracy?: number },
  ) {
    await this.trackingService.updatePosition({
      orderId: body.orderId,
      driverId: fbUser.uid,
      lat: body.lat,
      lng: body.lng,
      accuracy: body.accuracy,
    });

    const eta = await this.trackingService.calculateETA(body.orderId, body.lat, body.lng);

    // Broadcast aux clients connectés via WebSocket
    this.gateway.server
      ?.to(`order:${body.orderId}`)
      ?.emit('driver:position', {
        lat: body.lat,
        lng: body.lng,
        eta,
        timestamp: Date.now(),
        source: 'http', // debug : indique que c'est un fallback
      });

    return { eta };
  }

  /**
   * Sync batch — le livreur envoie plusieurs positions accumulées offline.
   * Appelé quand la connexion revient après une coupure.
   */
  @Post('position/batch')
  @Roles('LIVREUR')
  @HttpCode(HttpStatus.OK)
  async batchPositions(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body() body: {
      orderId: string;
      positions: { lat: number; lng: number; timestamp: number }[];
    },
  ) {
    // Enregistre seulement la dernière position pour le broadcast
    const last = body.positions[body.positions.length - 1];

    await this.trackingService.updatePosition({
      orderId: body.orderId,
      driverId: fbUser.uid,
      lat: last.lat,
      lng: last.lng,
    });

    return { synced: body.positions.length };
  }
}