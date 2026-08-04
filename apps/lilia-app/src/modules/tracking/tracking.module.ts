import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';
import { TrackingGateway } from './tracking.gateway';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule pour UserCacheService : la gateway relit le statut du compte à
  // chaque message (une socket ouverte survivait à un bannissement).
  imports: [AuthModule],
  providers: [TrackingService, TrackingGateway, FirebaseService],
  controllers: [TrackingController],
  exports: [TrackingGateway, TrackingService], // Gateway: OrdersListener/Deliveries ; Service: ETA fallback HTTP
})
export class TrackingModule {}
