// main.ts
// ⚠️ DOIT rester le tout premier import — initialise Sentry avant que les
// autres modules ne soient chargés (auto-instrumentation).
import './instrument';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { join } from 'path';
import { existsSync } from 'fs';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/exception-filters/http-exception.filter';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });
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
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? [];
  app.enableCors({
    // En dev : tout autoriser. En prod : liste blanche.
    origin:
      process.env.NODE_ENV === 'production' && allowedOrigins.length > 0
        ? allowedOrigins
        : true,
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
