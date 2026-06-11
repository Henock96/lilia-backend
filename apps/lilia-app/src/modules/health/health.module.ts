/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { FirebaseService } from '../firebase/firebase.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [FirebaseService],
  exports: [],
})
export class HealthsModule {}
