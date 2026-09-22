/* eslint-disable prettier/prettier */
// health/health.controller.ts
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import type Redis from 'ioredis';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { FirebaseService } from '../firebase/firebase.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { SkipResponseWrap } from '../../common/interceptors/api-response.interceptor';
import { SKIP_ALL_THROTTLERS } from '../../common/throttler/throttler-names';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly prisma: PrismaService,
    /**
     * ⚠️ Non optionnel, contrairement à une première version.
     *
     * `RedisModule.forRootAsync` est enregistré sans condition dans
     * `app.module.ts` et `RedisCoreModule` est `@Global()` : le client est
     * **toujours** résolu, même sans serveur Redis en face. Un troisième état
     * « absent » était donc inatteignable, et le commentaire qui le justifiait
     * décrivait une situation qui n'existe pas.
     *
     * Sans serveur joignable, `ping()` échoue et la sonde annonce `error` —
     * ce qui est exact, en développement comme en production.
     */
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /** Plafond d'attente de la sonde sur Redis. Voir `checkRedis`. */
  private static readonly REDIS_PROBE_TIMEOUT_MS = 1_000;

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
  @SkipThrottle(SKIP_ALL_THROTTLERS)
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
          resend: !!process.env.RESEND_API_KEY,
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
   *
   * Exempté de rate limiting (P-04) : le `ThrottlerGuard` coûtait ~545 ms de
   * Redis sur une route qui ne fait que retourner un objet littéral — soit la
   * quasi-totalité du temps de réponse de la sonde.
   */
  @Public()
  @SkipThrottle(SKIP_ALL_THROTTLERS)
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
   *
   * ⚠️ Volontairement **non** exempté de rate limiting, contrairement aux trois
   * autres sondes (P-04) : celle-ci déclenche un `SELECT 1` sur la base. La
   * déthrottler en ferait un levier d'amplification base de données, gratuit et
   * anonyme. Ici la dépense Redis achète une protection, elle n'est pas perdue.
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
    const redis = await this.checkRedis();
    const healthy = db === 'ok';

    res
      .status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        // Trois valeurs, parce qu'il y a trois situations distinctes :
        // `error` (la base ne répond pas — l'instance ne peut pas servir),
        // `degraded` (elle sert, mais avec des garanties en moins),
        // `ok`. Les fondre ferait choisir entre crier pour rien et se taire
        // quand il faut parler.
        status: !healthy ? 'error' : redis === 'error' ? 'degraded' : 'ok',
        db,
        firebase,
        /**
         * ⚠️ Redis n'est **pas** bloquant, et c'est délibéré.
         *
         * Son absence dégrade trois contrôles — idempotence du checkout, rate
         * limiting partagé, verrous de cron — mais les replis existent et
         * fonctionnent : sortir l'instance du service la rendrait moins
         * disponible sans rien réparer.
         *
         * Ce qui manquait n'était pas un verdict, c'était l'information :
         * `status: ok` se lisait « tout va bien » alors qu'il ne voulait dire
         * que « la base répond ».
         */
        redis,
        timestamp: new Date().toISOString(),
      });
  }

  /**
   * État de Redis, **borné localement**.
   *
   * ⚠️ Le client injecté est le profil « métier » : son seul plafond est
   * `commandTimeout`, 3 000 ms par défaut — et `.env.example` documente
   * `REDIS_COMMAND_TIMEOUT_MS` jusqu'à 30 000 ms comme le levier à poser sur
   * Render pendant un incident. Sans la borne ci-dessous, la sonde hériterait
   * de cette patience : elle attendrait jusqu'à trente secondes, et
   * l'orchestrateur retirerait du service une instance qui sert parfaitement —
   * l'exact inverse de « Redis n'est pas bloquant ».
   *
   * La borne appartient donc à la sonde, pas au client : une question de
   * disponibilité ne se règle pas avec la patience d'un profil dimensionné pour
   * préserver une garantie métier.
   *
   * Cette route paie déjà un aller-retour Redis pour le throttler (elle n'est
   * volontairement pas exemptée) : une seconde de plus est un plafond large.
   */
  private async checkRedis(): Promise<'ok' | 'error'> {
    let minuteur: NodeJS.Timeout | undefined;
    try {
      const borne = new Promise<never>((_, rejeter) => {
        minuteur = setTimeout(
          () => rejeter(new Error('ping Redis hors délai')),
          HealthController.REDIS_PROBE_TIMEOUT_MS,
        );
      });
      await Promise.race([this.redis.ping(), borne]);
      return 'ok';
    } catch {
      return 'error';
    } finally {
      // Sans ce nettoyage, le minuteur maintient la boucle d'événements en vie
      // jusqu'à son échéance — y compris à l'arrêt du processus.
      if (minuteur) clearTimeout(minuteur);
    }
  }

  @Public()
  @SkipThrottle(SKIP_ALL_THROTTLERS)
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
