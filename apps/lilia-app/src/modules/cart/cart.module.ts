import { Module } from '@nestjs/common';
import { CartService } from './cart.service';
import { CartController } from './cart.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { FirebaseService } from '../firebase/firebase.service';

@Module({
  imports: [PrismaModule],
  controllers: [CartController],
  providers: [CartService, FirebaseService],
  exports: [CartService], // Exportez le service si d'autres modules (comme Orders) en ont besoin
})
export class CartModule {}
