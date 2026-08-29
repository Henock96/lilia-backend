/* eslint-disable prettier/prettier */
// health/health.controller.ts
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { SkipResponseWrap } from '../../common/interceptors/api-response.interceptor';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Health check public — utilisé par Render pour les checks de liveness.
   *
   * ⚠️ Route PUBLIQUE (fix L3) : elle exposait `NODE_ENV`,
   * `RENDER_SERVICE_NAME` et la liste des secrets configurés (sous forme de
   * booléens). C'est du fingerprinting offert à un attaquant — il apprend
   * quelles intégrations tenter. Le détail de configuration n'est plus servi
   * qu'en dehors de la production, où il aide réellement au diagnostic.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Statut général de l\'application' })
  check() {
    const base = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };

    if (process.env.NODE_ENV === 'production') return base;

    return {
      ...base,
      firebase: { ready: this.firebase.isReady() },
      environment: {
        nodeEnv: process.env.NODE_ENV ?? 'development',
        service: process.env.RENDER_SERVICE_NAME ?? 'local',
        // Présence des variables — jamais les valeurs
        config: {
          firebaseProjectId: !!process.env.FIREBASE_PROJECT_ID,
          firebaseClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
          firebasePrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
          mailtrap: !!process.env.MAILTRAP_API_TOKEN,
          infobip: !!process.env.INFOBIP_API_KEY,
          redis: !!process.env.REDIS_URL,
        },
      },
    };
  }

  /**
   * Liveness probe — ultra-léger, aucune I/O (pas d'appel Firebase/DB).
   * Cible du monitoring externe UptimeRobot (LIL-36), pollé toutes les 30s.
   * Exclu de l'auto-log Pino pour ne pas polluer les logs.
   */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe (monitoring externe)' })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness probe — vérifie les dépendances joignables (DB + Firebase).
   * Distinct de /live : sert à savoir si l'instance peut servir du trafic.
   *
   * SÉCURITÉ / EXPLOITATION (fix M9) : la route répondait **200** avec
   * `status: 'error'` dans le corps quand la base était injoignable. Un
   * orchestrateur qui se fie au code HTTP — c'est-à-dire tous — continuait
   * donc à router du trafic vers une instance incapable de servir. On répond
   * désormais 503, et le corps reste identique pour les outils qui le lisent.
   */
  @Public()
  @SkipResponseWrap()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (DB + Firebase)' })
  async ready(@Res() res: Response) {
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }
    const firebase = this.firebase.isReady() ? 'ok' : 'error';
    const healthy = db === 'ok';

    res
      .status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        status: healthy ? 'ok' : 'error',
        db,
        firebase,
        timestamp: new Date().toISOString(),
      });
  }

  @Public()
  @Get('firebase')
  @ApiOperation({ summary: 'Statut Firebase Admin SDK' })
  checkFirebase() {
    return {
      status: this.firebase.isReady() ? 'ok' : 'error',
      ready: this.firebase.isReady(),
      messaging: this.firebase.isReady() ? 'available' : 'unavailable',
      timestamp: new Date().toISOString(),
    };
  }
}
