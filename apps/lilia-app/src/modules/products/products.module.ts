import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductQueryService } from './product-query.service';
import { ProductCommandService } from './product-command.service';
import { ProductsController } from './products.controller';
import { ProductValidatorService } from './product-validator.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
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
