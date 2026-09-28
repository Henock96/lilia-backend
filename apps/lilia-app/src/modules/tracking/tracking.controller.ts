// tracking/tracking.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { DecodedIdToken } from 'firebase-admin/auth';
import { TrackingService } from './tracking.service';
import { TrackingGateway } from './tracking.gateway';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  BatchPositionsDto,
  BufferedPositionDto,
  PositionDto,
} from './dto/tracking-http.dto';

/**
 * F3-12.1 (décision Q5) — au-delà de cet âge, le point le plus récent d'un
 * lot n'est plus « la position du livreur » : il décrit où il était. Le
 * diffuser comme position en direct ferait reculer le marqueur du client, et
 * l'ETA partirait d'un endroit que le livreur a quitté.
 */
export const LIVE_BATCH_MAX_AGE_MS = 120_000;

/** Le point le plus récent par horodatage — pas le dernier du tableau. */
export function latestPosition(
  positions: BufferedPositionDto[],
): BufferedPositionDto {
  return positions.reduce((a, b) => (b.timestamp >= a.timestamp ? b : a));
}

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
    // ⚠️ Une CLASSE, pas un type inline : un type n'existe pas au runtime, donc
    // le `ValidationPipe` global n'avait rien à valider et `lat`/`lng`
    // arrivaient bruts dans `GEOADD` Redis et dans le calcul de l'ETA.
    @Body() body: PositionDto,
  ) {
    // Sécurité : seul le livreur assigné peut publier sa position
    const { live } = await this.trackingService.assertCanUpdatePosition(
      body.orderId,
      fbUser.uid,
    );
    // F3-12.0 — hors `EN_TRANSIT`, ignorée sans erreur (pas de relance).
    if (!live) return { eta: null };

    await this.trackingService.updatePosition({
      orderId: body.orderId,
      driverId: fbUser.uid,
      lat: body.lat,
      lng: body.lng,
      accuracy: body.accuracy,
    });

    const eta = await this.trackingService.calculateETA(
      body.orderId,
      body.lat,
      body.lng,
    );

    // Broadcast aux clients connectés via WebSocket
    this.gateway.broadcastDriverPosition(body.orderId, {
      lat: body.lat,
      lng: body.lng,
      eta,
      source: 'http',
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
    // Le lot est borné et **chaque** point validé (`@ValidateNested`) : le
    // contrôleur n'utilise que le dernier, une validation superficielle
    // laisserait donc passer précisément la valeur qui atteint Redis.
    // La garde « tableau vide » vit désormais dans le DTO (`@ArrayMinSize(1)`).
    @Body() body: BatchPositionsDto,
  ) {
    const { live } = await this.trackingService.assertCanUpdatePosition(
      body.orderId,
      fbUser.uid,
    );
    // F3-12.0 — hors `EN_TRANSIT`, le lot est acquitté sans être diffusé :
    // un 4xx ferait rejouer indéfiniment un lot qui ne passera jamais.
    if (!live) return { synced: body.positions.length, eta: null };

    // Seule la position la plus RÉCENTE circule. Le dernier élément du
    // tableau n'est pas forcément elle : l'app trie, mais le contrat ne
    // l'exige pas, et une file mal ordonnée ferait reculer le marqueur.
    const last = latestPosition(body.positions);

    // Q5 — un lot rejoué après une longue coupure est acquitté (2xx : l'app
    // le retire de sa file) mais n'est pas diffusé comme position en direct.
    if (Date.now() - last.timestamp > LIVE_BATCH_MAX_AGE_MS) {
      return { synced: body.positions.length, eta: null };
    }

    await this.trackingService.updatePosition({
      orderId: body.orderId,
      driverId: fbUser.uid,
      lat: last.lat,
      lng: last.lng,
      accuracy: last.accuracy,
    });

    const eta = await this.trackingService.calculateETA(
      body.orderId,
      last.lat,
      last.lng,
    );

    this.gateway.broadcastDriverPosition(body.orderId, {
      lat: last.lat,
      lng: last.lng,
      eta,
      source: 'http-batch',
    });

    return { synced: body.positions.length, eta };
  }
}
