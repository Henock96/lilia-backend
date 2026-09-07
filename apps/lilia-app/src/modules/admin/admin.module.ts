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
import { LoyaltyAdminService } from '../loyalty/loyalty-admin.service';

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
    // Écritures d'administration sur la fidélité (ajustement manuel tracé,
    // arbitrage des récompenses de parrainage).
    //
    // Déclaré ICI et non dans `LoyaltyModule` : il dépend d'`AdminAuditService`,
    // qui est `@Global()` mais global au seul graphe qui le déclare —
    // `AppModule`. `LoyaltyModule`, lui, est aussi dans le graphe du worker
    // (via `OrdersCoreModule`), où `AdminAuditModule` n'existe pas. L'y laisser
    // faisait mourir le worker au bootstrap, sans que ni `tsc`, ni les tests,
    // ni le build ne puissent l'attraper.
    LoyaltyAdminService,
  ],
})
export class AdminModule {}
