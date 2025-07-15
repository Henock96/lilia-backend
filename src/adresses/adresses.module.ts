import { Module } from '@nestjs/common';
import { AdressesController } from './adresses.controller';
import { AdressesService } from './adresses.service';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AdressesController],
  providers: [AdressesService],
})
export class AdressesModule {}
