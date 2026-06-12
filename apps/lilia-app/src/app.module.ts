// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';

import { SentryUserInterceptor } from './common/interceptors/sentry-user.interceptor';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';

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
import { CartModule } from './modules/cart/cart.module';
import { MenusModule } from './modules/menus/menus.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
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

// Listeners (providers globaux)
import { OrdersListener } from './modules/listeners/orders.listener';
import { PaymentListener } from './modules/listeners/payment.listener';
import { MenusListener } from './modules/listeners/menus.listener';
import { UserListener } from './modules/listeners/user.listener';
import { VendorsListener } from './modules/listeners/vendors.listener';
import { TrackingModule } from './modules/tracking/tracking.module';
// Email + SMS de bienvenue : gérés par UserListener (modules/listeners/user.listener.ts)
import { RedisModule } from '@nestjs-modules/ioredis';
import { envValidationSchema } from './config/env.validation';
@Module({
  imports: [
    // Sentry — doit être l'un des tout premiers modules importés.
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
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
          throttlers: [
            { name: 'short', ttl: 1000, limit: 10 },
            { name: 'long', ttl: 60000, limit: 100 },
          ],
          storage: redisUrl
            ? new ThrottlerStorageRedisService(redisUrl)
            : undefined,
        };
      },
    }),
    // app.module.ts â€” ajouter
    RedisModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        type: 'single',
        url: config.get('REDIS_URL'),
      }),
      inject: [ConfigService],
    }),
    TrackingModule,
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20, // augmentÃ© pour tous les listeners
      ignoreErrors: false,
    }),

    // Core
    PrismaModule,
    FirebaseModule,
    AuthModule, // enregistre APP_GUARD globalement

    // Domaines
    UsersModule,
    RestaurantsModule,
    ProductsModule,
    CategoriesModule,
    OrdersModule,
    DeliveriesModule,
    CartModule,
    MenusModule,
    ReviewsModule,
    PaymentModule,
    AdressesModule,
    QuartiersModule,
    BannersModule,
    AdminModule,
    PlatformSettingsModule,
    DashboardModule,
    PromoModule,
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
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
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
    PaymentListener,
    MenusListener,
    UserListener,
    VendorsListener,
  ],
})
export class AppModule {}

