import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminDeliverersService } from './admin-deliverers.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminVendorsService } from './admin-vendors.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminUsersService } from './admin-users.service';
import { AdminReviewsService } from './admin-reviews.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminRestaurantsService } from './admin-restaurants.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';
import { VendorsModule } from '../vendors/vendors.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';

@Module({
  imports: [FirebaseModule, AuthModule, VendorsModule, LoyaltyModule], // VendorsModule expose VendorsService ; LoyaltyModule expose la réconciliation (M13)
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminDeliverersService,
    AdminPaymentsService,
    AdminVendorsService,
    AdminClientsService,
    AdminUsersService,
    AdminReviewsService,
    AdminDashboardService,
    AdminRestaurantsService,
  ],
})
export class AdminModule {}
