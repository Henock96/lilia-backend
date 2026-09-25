// app.module.ts
import { OpsModule } from './modules/ops/ops.module';
import { OrderOutboxEffectsModule } from './modules/outbox/order-outbox-effects.module';
import { PayoutOutboxEffectsModule } from './modules/outbox/payout-outbox-effects.module';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';

import { SentryUserInterceptor } from './common/interceptors/sentry-user.interceptor';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { resolveThrottlerTracker } from './common/throttler/throttler-tracker';
import { ParallelThrottlerGuard } from './common/throttler/parallel-throttler.guard';
import {
  THROTTLER_LONG,
  THROTTLER_SHORT,
} from './common/throttler/throttler-names';
import { buildRedisOptions } from './common/redis/redis-options';
import { instrumentIoredis } from './common/redis/redis-metrics';
import { RedisMetricsMiddleware } from './common/redis/redis-metrics.middleware';
import { RequestContextMiddleware } from './common/context/request-context.middleware';

import { PrismaModule } from './prisma/prisma.module';
import { FirebaseModule } from './modules/firebase/firebase.module';
import { AuthModule } from './modules/auth/auth.module';

// Domaines
import { UsersModule } from './modules/users/users.module';
import { RestaurantsModule } from './modules/restaurants/restaurants.module';
import { ProductsModule } from './modules/products/products.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { OrdersModule } from './modules/orders/orders.module';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { CartModule } from './modules/cart/cart.module';
import { MenusModule } from './modules/menus/menus.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { DeliveryReviewsModule } from './modules/delivery-reviews/delivery-reviews.module';
import { PaymentModule } from './modules/payments/payment.module';
import { AdressesModule } from './modules/adresses/adresses.module';
import { QuartiersModule } from './modules/quartiers/quartiers.module';
import { BannersModule } from './modules/banners/banners.module';
import { AdminModule } from './modules/admin/admin.module';
import { PlatformSettingsModule } from './modules/platform-settings/platform-settings.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { PromoModule } from './modules/promo/promo.module';
import { FavoritesModule } from './modules/favorites/favorites.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { VendorPhotosModule } from './modules/vendor-photos/vendor-photos.module';
import { ProductImagesModule } from './modules/product-images/product-images.module';
import { MenuImagesModule } from './modules/menu-images/menu-images.module';

// Infrastructure
import { NotificationsModule } from './modules/notifications/notifications.module';
import { EmailModule } from './modules/email/email.module';
import { SmsModule } from './modules/sms/sms.module';
import { CloudinaryModule } from './modules/cloudinary/cloudinary.module';
import { AppScheduleModule } from './modules/schedule/schedule.module';
import { HealthsModule } from './modules/health/health.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { AdminAuditModule } from './modules/admin-audit/admin-audit.module';
import { RefundsModule } from './modules/refunds/refunds.module';
import { ClaimsModule } from './modules/claims/claims.module';
import { OutboxModule } from './modules/outbox/outbox.module';

import { CatalogCacheModule } from './modules/catalog-cache/catalog-cache.module';

// Listeners (providers globaux)
import { OrdersListener } from './modules/listeners/orders.listener';
import { DeliveriesListener } from './modules/listeners/deliveries.listener';
import { PaymentListener } from './modules/listeners/payment.listener';
import { PayoutListener } from './modules/listeners/payout.listener';
import { MenusListener } from './modules/listeners/menus.listener';
import { UserListener } from './modules/listeners/user.listener';
import { VendorsListener } from './modules/listeners/vendors.listener';
import { LoyaltyListener } from './modules/listeners/loyalty.listener';
import { TrackingModule } from './modules/tracking/tracking.module';
// Email + SMS de bienvenue : gérés par UserListener (modules/listeners/user.listener.ts)
import { RedisModule } from '@nestjs-modules/ioredis';
import { envValidationSchema } from './config/env.validation';
import { DeliveryPricingModule } from './modules/delivery-pricing/delivery-pricing.module';
@Module({
  imports: [
    // Sentry — doit être l'un des tout premiers modules importés.
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      /**
       * Cascade d'environnements — **la première entrée gagne**.
       *
       * Le `.env` de ce dépôt porte les identifiants de production (base Neon,
       * Redis Upstash) : c'est commode pour inspecter la vraie plateforme, et
       * c'est exactement ce qui faisait qu'un `npm run start:dev` lancé
       * distraitement écrivait dans la base des vrais clients.
       *
       * `.env.development` (versionné, **sans aucun secret**) ne redéfinit que
       * ce qui doit rester local — base et Redis. Tout le reste continue de
       * venir de `.env`, ce qui évite de dupliquer douze clés d'API.
       *
       * `.env.local` reste au-dessus pour les surcharges personnelles non
       * versionnées. Sur Render, aucun de ces fichiers n'existe : les variables
       * viennent du service, et `process.env` prime de toute façon.
       */
      envFilePath: [
        '.env.local',
        `.env.${process.env.NODE_ENV ?? 'development'}`,
        '.env',
      ],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false }, // remonte TOUTES les erreurs d'env d'un coup
    }),
    // ─── Logs structurés Pino (LIL-35) ──────────────────────────────────────
    // Prod : JSON sur stdout (ingérable Grafana/Datadog). Dev : pino-pretty.
    // Chaque log porte un `req.id` ; chaque requête est auto-loggée avec sa
    // durée (`responseTime`). Secrets jamais en clair (redact).
    LoggerModule.forRoot({
      pinoHttp: {
        level:
          process.env.LOG_LEVEL ??
          (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  translateTime: 'SYS:HH:MM:ss',
                  ignore: 'pid,hostname',
                },
              }
            : undefined,
        // Jamais de token Firebase / mot de passe / cookie en clair dans les logs.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.headers["idempotency-key"]',
            'req.body.password',
            'req.body.token',
            'req.body.idToken',
            '*.password',
            '*.token',
            '*.authorization',
            '*.idToken',
            '*.accessToken',
          ],
          censor: '[Redacted]',
        },
        // `reqId` : réutilise un `X-Request-Id` entrant sinon génère un UUID,
        // et le renvoie au client pour corréler front ↔ back.
        genReqId: (req, res) => {
          const incoming = req.headers['x-request-id'];
          const id =
            (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        // Niveau de log dérivé du statut HTTP.
        customLogLevel: (_req, res, err) => {
          if (res.statusCode >= 500 || err) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        // Auto-log de chaque requête (durée incluse), sauf le bruit des health
        // checks (UptimeRobot tape /health/live toutes les 30s — LIL-36).
        autoLogging: {
          ignore: (req) => (req.url ?? '').startsWith('/health'),
        },
      },
    }),
    // Throttler avec storage Redis si REDIS_URL est défini → limites PARTAGÉES
    // entre les instances Render (sinon chaque instance a son propre compteur et
    // la limite effective = limit × nbInstances). Fallback mémoire en local.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL');
        return {
          // ⚠️ Noms tirés de `common/throttler/throttler-names.ts` : les routes
          // exemptées les réutilisent, car `@SkipThrottle()` sans argument vise
          // un limiteur `default` qui n'existe pas ici et n'exempte rien (P-04).
          throttlers: [
            { name: THROTTLER_SHORT, ttl: 1000, limit: 10 },
            { name: THROTTLER_LONG, ttl: 60000, limit: 100 },
          ],
          // Traçage par COMPTE quand un jeton est présent, par IP sinon
          // (fix C4) — voir common/throttler/throttler-tracker.ts.
          getTracker: resolveThrottlerTracker,
          // Connexion dédiée, avec un `commandTimeout` plus court que celui du
          // client métier : le rate limiting est une protection, il doit
          // échouer vite. Voir `common/redis/redis-options.ts`.
          storage: redisUrl
            ? new ThrottlerStorageRedisService(
                redisUrl,
                buildRedisOptions({ usage: 'throttler', config }),
              )
            : undefined,
        };
      },
    }),
    // Client Redis partagé : cache utilisateur (RolesGuard), idempotence du
    // checkout, verrous de cron. Profil « business » — patient, parce qu'une
    // commande perdue ici fait perdre une garantie métier, pas du confort.
    RedisModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        type: 'single',
        url: config.get('REDIS_URL'),
        options: buildRedisOptions({ usage: 'business', config }),
      }),
      inject: [ConfigService],
    }),
    TrackingModule,
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20, // augmenté pour tous les listeners
      ignoreErrors: false,
    }),

    // Core
    PrismaModule,
    FirebaseModule,
    AuthModule, // enregistre APP_GUARD globalement

    // Domaines
    UsersModule,
    RestaurantsModule,
    // Invalide le cache du site public après une écriture au catalogue.
    // Sans controller : rien de nouveau n'est exposé.
    CatalogCacheModule,
    ProductsModule,
    CategoriesModule,
    OrdersModule,
    DeliveriesModule,
    DriversModule,
    CartModule,
    MenusModule,
    ReviewsModule,
    DeliveryReviewsModule,
    PaymentModule,
    AdressesModule,
    QuartiersModule,
    DeliveryPricingModule,
    BannersModule,
    AdminModule,
    PlatformSettingsModule,
    DashboardModule,
    PromoModule,
    OpsModule,
    FavoritesModule,
    VendorsModule,
    VendorPhotosModule,
    ProductImagesModule,
    MenuImagesModule,

    // Infrastructure
    NotificationsModule,
    EmailModule,
    SmsModule,
    CloudinaryModule,
    AppScheduleModule,
    HealthsModule,
    IncidentsModule,
    AdminAuditModule,
    RefundsModule,
    ClaimsModule,
    OutboxModule,
    OrderOutboxEffectsModule, // lot 4 : effets de commande rejoués par l'outbox
    PayoutOutboxEffectsModule, // F3-07 : notifications de versement par l'outbox
  ],
  providers: [
    // `ParallelThrottlerGuard` et non `ThrottlerGuard` : les deux limiteurs
    // (`short` 10/s, `long` 100/min) sont CONSERVÉS, mais leurs deux `EVAL`
    // Redis partent ensemble au lieu de s'enchaîner — 2 allers-retours
    // deviennent 1. Voir `common/throttler/parallel-throttler.guard.ts`.
    { provide: APP_GUARD, useClass: ParallelThrottlerGuard },
    // ⚠️ Ordre des intercepteurs : NestJS exécute les intercepteurs APP_INTERCEPTOR
    // dans l'ordre de déclaration sur le chemin entrant, et en sens inverse sur
    // le chemin sortant (réponse). ApiResponseInterceptor doit être le DERNIER
    // à voir la réponse (donc le PREMIER à être déclaré) pour wrapper le payload
    // final, après que SentryUserInterceptor a fait son boulot côté request.
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    // Attache le user courant au scope Sentry de chaque requête
    { provide: APP_INTERCEPTOR, useClass: SentryUserInterceptor },
    // Listeners globaux
    OrdersListener,
    DeliveriesListener,
    PaymentListener,
    PayoutListener,
    MenusListener,
    UserListener,
    VendorsListener,
    LoyaltyListener,
    RedisMetricsMiddleware,
    RequestContextMiddleware,
  ],
})
export class AppModule implements NestModule {
  constructor() {
    // Enveloppe le prototype ioredis pour compter les commandes par requête.
    // Fait ici plutôt que dans `main.ts` pour que les tests d'intégration, qui
    // construisent le module sans passer par le bootstrap, mesurent aussi.
    // Idempotent.
    instrumentIoredis();
  }

  configure(consumer: MiddlewareConsumer): void {
    // ⚠️ MIDDLEWARE et non intercepteur : Nest exécute les middlewares AVANT
    // les guards, les intercepteurs APRÈS. Les trois appels Redis les plus
    // coûteux (2 × ThrottlerGuard + 1 × cache utilisateur du RolesGuard) ont
    // lieu dans les guards — un intercepteur les raterait tous.
    //
    // `RequestContextMiddleware` vient en PREMIER, pour la même raison poussée
    // un cran plus loin : il ouvre le périmètre de corrélation, et tout ce qui
    // s'exécute ensuite — guards compris — doit s'y trouver.
    consumer
      .apply(RequestContextMiddleware, RedisMetricsMiddleware)
      .forRoutes('*');
  }
}
