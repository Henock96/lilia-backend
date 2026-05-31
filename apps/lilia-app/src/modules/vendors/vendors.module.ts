/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PaginationService } from '../../common/pagination/pagination.service';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { PreorderValidatorService } from './preorder-validator.service';

@Module({
  imports: [PrismaModule],
  controllers: [VendorsController],
  providers: [VendorsService, PreorderValidatorService, PaginationService],
  exports: [VendorsService, PreorderValidatorService],
})
export class VendorsModule {}
