import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { ProductsModule } from './products/products.module';
import { CategoriesModule } from './categories/categories.module';
import { OrdersModule } from './orders/orders.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { SmsModule } from './sms/sms.module';
import { FirebaseModule } from './firebase/firebase.module';
import { AdressesModule } from './adresses/adresses.module';
import { CartModule } from './cart/cart.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { NotificationsModule } from './notifications/notifications.module';
import { OrdersListener } from './listeners/orders.listener';
import { HealthsModule } from './health/health.module';
import { PaymentModule } from './payments/payment.module';
import { PaymentListener } from './listeners/payment.listener';
import { MenusModule } from './menus/menus.module';
import { MenusListener } from './listeners/menus.listener';
import { ReviewsModule } from './reviews/reviews.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    EventEmitterModule.forRoot({
      // Configuration optionnelle
      wildcard: false,
      delimiter: '.',
      newListener: false,
      removeListener: false,
      maxListeners: 10,
      verboseMemoryLeak: false,
      ignoreErrors: false,
    }),
    PrismaModule,
    UsersModule,
    RestaurantsModule,
    ProductsModule,
    CategoriesModule,
    OrdersModule,
    DeliveriesModule,
    CloudinaryModule,
    SmsModule,
    FirebaseModule,
    CartModule,
    AdressesModule,
    NotificationsModule,
    HealthsModule,
    PaymentModule,
    MenusModule,
    ReviewsModule,
  ],
  controllers: [AppController],
  providers: [AppService, OrdersListener, PaymentListener, MenusListener],
})
export class AppModule {}
