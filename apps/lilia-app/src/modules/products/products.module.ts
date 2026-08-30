import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductQueryService } from './product-query.service';
import { ProductCommandService } from './product-command.service';
import { ProductsController } from './products.controller';
import { ProductValidatorService } from './product-validator.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';

@Module({
  // `RestaurantsModule` fournit `RestaurantAccessService`, qui arbitre le
  // vendeur cible d'une écriture au catalogue (le sien, ou celui qu'un ADMIN
  // désigne explicitement).
  imports: [PrismaModule, RestaurantsModule],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    ProductQueryService,
    ProductCommandService,
    ProductValidatorService,
  ],
  exports: [ProductValidatorService],
})
export class ProductsModule {}
