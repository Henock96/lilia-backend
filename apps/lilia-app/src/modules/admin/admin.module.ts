import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminDeliverersService } from './admin-deliverers.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminVendorsService } from './admin-vendors.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';
import { VendorsModule } from '../vendors/vendors.module';

@Module({
  imports: [FirebaseModule, AuthModule, VendorsModule], // VendorsModule expose VendorsService
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminDeliverersService,
    AdminPaymentsService,
    AdminVendorsService,
  ],
})
export class AdminModule {}
