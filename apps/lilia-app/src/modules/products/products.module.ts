import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { PaginationService } from '../../common/pagination/pagination.service';

@Module({
  imports: [PrismaModule],
  controllers: [ProductsController],
  providers: [ProductsService, PaginationService],
})
export class ProductsModule {}
