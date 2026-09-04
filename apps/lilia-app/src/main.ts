// main.ts
// ⚠️ DOIT rester le tout premier import — initialise Sentry avant que les
// autres modules ne soient chargés (auto-instrumentation).
import './instrument';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as compression from 'compression';
import { join } from 'path';
import { existsSync } from 'fs';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/exception-filters/http-exception.filter';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';
import { CORS_ALLOWED_HEADERS } from './common/http/cors-headers';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // bufferLogs : on tamponne les logs internes Nest jusqu'à ce que le logger
  // Pino soit branché via useLogger (LIL-35), pour que TOUT passe par Pino.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // rawBody : conserve les octets exacts du corps de requête dans `req.rawBody`.
    //
    // Indispensable pour vérifier une signature de webhook calculée SUR LE CORPS
    // BRUT (pawaPay signe selon RFC-9421 : `Content-Digest` est un hash du corps
    // tel qu'envoyé). Sans ce drapeau, Express parse le JSON puis on ne dispose
    // que de l'objet : le re-sérialiser produit des octets différents (ordre des
    // clés, espaces, échappement Unicode) et le digest ne correspond jamais.
    //
    // Le surcoût est une copie du corps en mémoire ; il est borné par la limite
    // de taille du body parser et négligeable sur une API JSON.
    rawBody: true,
  });
  // Remplace le logger natif par Pino (logs structurés JSON en prod).
  app.useLogger(app.get(PinoLogger));
  // WebSocket adapter — Redis si REDIS_URL configuré, sinon adapter par défaut
  if (process.env.REDIS_URL) {
    try {
      const redisIoAdapter = new RedisIoAdapter(app);
      await redisIoAdapter.connectToRedis(process.env.REDIS_URL);
      app.useWebSocketAdapter(redisIoAdapter);
      logger.log('WebSocket adapter : Redis (multi-instance)');
    } catch (err) {
      logger.warn(
        `Redis non disponible, adapter par défaut utilisé : ${err.message}`,
      );
    }
  } else {
    logger.warn('REDIS_URL non défini — WebSocket en mode single-instance');
  }
  // ─── Confiance au proxy (fix C4) ────────────────────────────────────────────
  // Render place un load balancer devant l'app. Sans `trust proxy`, Express
  // ignore `X-Forwarded-For` et `req.ip` vaut l'adresse du proxy — la MÊME pour
  // tous les clients. Le ThrottlerGuard, qui trace par `req.ip`, dégénérait
  // alors en un compteur GLOBAL par route : 10 POST /orders/checkout en une
  // minute suffisaient à renvoyer 429 à toute la plateforme.
  // La valeur 1 = un seul proxy de confiance (celui de Render) ; passer `true`
  // laisserait n'importe qui usurper son IP via un en-tête forgé.
  const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10);
  app.set('trust proxy', trustProxyHops);
  logger.log(`trust proxy = ${trustProxyHops}`);

  // ─── Sécurité HTTP & compression ────────────────────────────────────────────
  // helmet : en-têtes de sécurité (X-Content-Type-Options, HSTS, etc.).
  // CSP désactivée : c'est une API JSON (les fronts gèrent leur propre CSP) et la
  // CSP par défaut casse l'UI Swagger en dev. crossOriginResourcePolicy en
  // 'cross-origin' pour autoriser la consommation cross-domain par les 3 apps.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  // compression gzip des réponses (gain réseau sur la 4G de Brazzaville).
  app.use(compression());

  // ─── Dossier statique public (optionnel) ────────────────────────────────────
  // process.cwd() = racine du projet (fonctionne avec webpack monorepo)
  const publicDir = join(process.cwd(), 'public');
  if (existsSync(publicDir)) {
    app.useStaticAssets(publicDir);
  }

  // ─── Validation globale des DTOs ────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // supprime les champs non déclarés dans les DTOs
      forbidNonWhitelisted: false,
      transform: true, // transforme les query params string → number/boolean
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ─── Filtre d'exception global ──────────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());

  // ─── CORS ───────────────────────────────────────────────────────────────────
  const isProduction = process.env.NODE_ENV === 'production';
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // En production, refléter TOUTE origine avec `credentials: true` est une faille
  // (CSRF / exfiltration cross-site). On exige une liste blanche explicite et on
  // échoue au démarrage si elle est absente plutôt que de basculer en `true`.
  if (isProduction && allowedOrigins.length === 0) {
    throw new Error(
      'ALLOWED_ORIGINS doit être défini en production (liste blanche CORS). ' +
        'Ex: ALLOWED_ORIGINS=https://lilia-food.com,https://admin.lilia-food.com',
    );
  }

  app.enableCors({
    // Prod : liste blanche stricte. Dev : tout autoriser pour le confort local.
    origin: isProduction ? allowedOrigins : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    /**
     * ⚠️ Cette liste doit contenir **tout** en-tête que les clients web
     * envoient, sans quoi le navigateur refuse d'émettre la requête après un
     * préflight pourtant réussi.
     *
     * `X-Lilia-Payment-Flow` y manquait. Il est ajouté par `apiClient` à
     * **chaque** requête depuis le 31/08/2026 (déclaration de capacité
     * d'encaissement, lue par `payment.controller.ts`), mais n'a jamais été
     * autorisé ici. Conséquence, mesurée sur l'admin déployé le 04/09/2026 :
     *
     *   OPTIONS /admin/vendors        → 204, en-têtes CORS corrects
     *   GET     /admin/vendors        → JAMAIS ÉMIS par le navigateur
     *
     * Le préflight réussissait, donc rien ne semblait cassé côté serveur — et
     * les deux applications web n'affichaient plus aucune donnée authentifiée.
     * Le tableau de bord restait indéfiniment en squelettes, les listes
     * annonçaient « Aucun vendeur », et aucune erreur n'apparaissait : une
     * requête refusée au préflight ne produit qu'un `TypeError: Failed to
     * fetch` que React Query traite comme un échec réseau ordinaire.
     *
     * **Règle : ajouter un en-tête personnalisé dans `packages/api-client`
     * oblige à l'ajouter ici, dans le même changement.** Le test
     * `cors-allowed-headers.spec.ts` fige cette correspondance.
     */
    allowedHeaders: CORS_ALLOWED_HEADERS.join(','),
    credentials: true,
  });

  // ─── Swagger ────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    // Swagger uniquement en dev/staging — pas exposé en prod
    const config = new DocumentBuilder()
      .setTitle('Lilia Food API')
      .setDescription('API de la plateforme de livraison Lilia Food')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api-docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });

    logger.log('Swagger disponible : /api-docs');
  }

  // ─── Arrêt propre (fix M10) ─────────────────────────────────────────────────
  // Sans cet appel, NestJS n'écoute pas SIGTERM et `onModuleDestroy` n'est
  // JAMAIS exécuté : à chaque déploiement Render, les connexions Redis de
  // TrackingService restaient ouvertes jusqu'au timeout côté serveur.
  app.enableShutdownHooks();

  // ─── Démarrage ──────────────────────────────────────────────────────────────
  const port = parseInt(process.env.PORT ?? '8080', 10);
  await app.listen(port, '0.0.0.0');
  logger.log(`Application démarrée sur le port ${port}`);
  logger.log(`Environnement : ${process.env.NODE_ENV ?? 'development'}`);
}

bootstrap().catch((error) => {
  console.error('Erreur fatale au démarrage :', error);
  process.exit(1);
});
