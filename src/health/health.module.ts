/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { FirebaseService } from 'src/firebase/firebase.service';

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [FirebaseService],
  exports: [],
})
export class HealthsModule {}
