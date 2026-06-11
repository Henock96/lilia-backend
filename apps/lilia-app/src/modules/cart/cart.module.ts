import { Module } from '@nestjs/common';
import { CartService } from './cart.service';
import { CartCommonService } from './cart-common.service';
import { CartItemsService } from './cart-items.service';
import { CartMenusService } from './cart-menus.service';
import { CartController } from './cart.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { FirebaseService } from '../firebase/firebase.service';

@Module({
  imports: [PrismaModule],
  controllers: [CartController],
  providers: [
    CartService,
    CartCommonService,
    CartItemsService,
    CartMenusService,
    FirebaseService,
  ],
  exports: [CartService], // Exportez le service si d'autres modules (comme Orders) en ont besoin
})
export class CartModule {}
