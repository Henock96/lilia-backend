import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FirebaseModule, AuthModule], // AuthModule expose UserCacheService
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
