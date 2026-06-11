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

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // bufferLogs : on tamponne les logs internes Nest jusqu'à ce que le logger
  // Pino soit branché via useLogger (LIL-35), pour que TOUT passe par Pino.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
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
      logger.warn(`Redis non disponible, adapter par défaut utilisé : ${err.message}`);
    }
  } else {
    logger.warn('REDIS_URL non défini — WebSocket en mode single-instance');
  }
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
    allowedHeaders: 'Content-Type,Authorization,Idempotency-Key',
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
