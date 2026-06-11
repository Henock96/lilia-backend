/* eslint-disable prettier/prettier */
// health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Health check public — utilisé par Render pour les checks de liveness.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Statut général de l\'application' })
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
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
          africasTalking: !!process.env.AFRICAS_TALKING_API_KEY,
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
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (DB + Firebase)' })
  async ready() {
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }
    const firebase = this.firebase.isReady() ? 'ok' : 'error';
    return {
      status: db === 'ok' ? 'ok' : 'error',
      db,
      firebase,
      timestamp: new Date().toISOString(),
    };
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