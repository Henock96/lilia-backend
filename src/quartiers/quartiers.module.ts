/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { QuartiersController } from './quartiers.controller';
import { QuartiersService } from './quartiers.service';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [QuartiersController],
  providers: [QuartiersService],
  exports: [QuartiersService],
})
export class QuartiersModule {}
