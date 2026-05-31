// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';

import { SentryUserInterceptor } from './common/interceptors/sentry-user.interceptor';

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
// EmailListener supprimÃ© â€” logique dÃ©placÃ©e dans UserListener
import { RedisModule } from '@nestjs-modules/ioredis';
@Module({
  imports: [
    // Sentry — doit être l'un des tout premiers modules importés.
    SentryModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 10 },
      { name: 'long', ttl: 60000, limit: 100 },
    ]),
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

