// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';

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
import { DashboardModule } from './modules/dashboard/dashboard.module';

// Infrastructure
import { NotificationsModule } from './modules/notifications/notifications.module';
import { EmailModule } from './modules/email/email.module';
import { SmsModule } from './modules/sms/sms.module';
import { CloudinaryModule } from './modules/cloudinary/cloudinary.module';
import { AppScheduleModule } from './modules/schedule/schedule.module';
import { HealthsModule } from './modules/health/health.module';

// Listeners (providers globaux)
import { OrdersListener } from './modules/listeners/orders.listener';
import { PaymentListener } from './modules/listeners/payment.listener';
import { MenusListener } from './modules/listeners/menus.listener';
import { UserListener } from './modules/listeners/user.listener';
// EmailListener supprimé — logique déplacée dans UserListener

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
    DashboardModule,

    // Infrastructure
    NotificationsModule,
    EmailModule,
    SmsModule,
    CloudinaryModule,
    AppScheduleModule,
    HealthsModule,
  ],
  providers: [
    // Listeners globaux
    OrdersListener,
    PaymentListener,
    MenusListener,
    UserListener,
  ],
})
export class AppModule {}
