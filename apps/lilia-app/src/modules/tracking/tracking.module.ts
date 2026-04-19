import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';
import { TrackingGateway } from './tracking.gateway';
import { FirebaseService } from '../firebase/firebase.service';

@Module({
  providers: [TrackingService, TrackingGateway, FirebaseService],
  controllers: [TrackingController],
  exports: [TrackingGateway], // exporté pour que OrdersListener puisse notifier

})
export class TrackingModule {}
