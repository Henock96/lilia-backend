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
import { AuthModule } from './auth/auth.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { SmsModule } from './sms/sms.module';
import { FirebaseModule } from './firebase/firebase.module';
import { AdressesModule } from './adresses/adresses.module';
import { CartModule } from './cart/cart.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    EventEmitterModule.forRoot(),
    PrismaModule,
    UsersModule,
    RestaurantsModule,
    ProductsModule,
    CategoriesModule,
    OrdersModule,
    DeliveriesModule,
    AuthModule,
    CloudinaryModule,
    SmsModule,
    FirebaseModule,
    CartModule,
    AdressesModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
