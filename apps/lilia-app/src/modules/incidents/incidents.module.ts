import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { IncidentsController } from './incidents.controller';
import { IncidentsListener } from './incidents.listener';
import { IncidentsService } from './incidents.service';

@Module({
  imports: [PrismaModule],
  controllers: [IncidentsController],
  providers: [IncidentsService, IncidentsListener],
  exports: [IncidentsService],
})
export class IncidentsModule {}
