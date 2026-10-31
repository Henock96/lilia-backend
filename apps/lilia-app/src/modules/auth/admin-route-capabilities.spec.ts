import { collectAdminRoutes } from '../../../test/admin-routes';

/**
 * F3-08 — classement de TOUTES les routes ouvertes au rôle ADMIN.
 *
 * Chaque route porte soit une capacité (`@RequireCapability`), soit `NONE`
 * (tout administrateur). Une route nouvelle non classée fait échouer ce test :
 * il faut décider, en la créant, si elle fait partir de l'argent (motif
 * `cors-allowed-headers.spec.ts`). La liste vient des métadonnées Nest des
 * contrôleurs, pas d'une énumération tenue à la main.
 *
 * - FINANCE_EXECUTE : fait partir de l'argent, ou fixe ce qui revient à
 *   quelqu'un (commission, points, avoir, paiement déclaré reçu).
 * - FINANCE_APPROVE : second administrateur d'un geste financier.
 * - USER_ROLES : rôles, bannissements, capacités.
 * - SETTINGS : paramètres plateforme, grille de livraison, codes promo.
 */
const ADMIN_ROUTE_CAPABILITIES: Record<string, string> = {
  'AdminController.adjustClientLoyalty': 'FINANCE_EXECUTE',
  'AdminController.approveVendor': 'NONE',
  'AdminController.banUser': 'USER_ROLES',
  'AdminController.createRestaurantWithOwner': 'NONE',
  'AdminController.deleteReview': 'NONE',
  'AdminController.getActiveOrders': 'NONE',
  'AdminController.getAllClients': 'NONE',
  'AdminController.getAllDeliverers': 'NONE',
  'AdminController.getAllOrders': 'NONE',
  'AdminController.getAllRestaurants': 'NONE',
  'AdminController.getAllReviews': 'NONE',
  'AdminController.getAllUsers': 'NONE',
  'AdminController.getAllVendors': 'NONE',
  'AdminController.getAuditLog': 'NONE',
  'AdminController.getClientLoyalty': 'NONE',
  'AdminController.getClientReferral': 'NONE',
  'AdminController.getDashboardStats': 'NONE',
  'AdminController.getDelivererMissions': 'NONE',
  'AdminController.getDelivererStats': 'NONE',
  'AdminController.getLoyaltyDrifts': 'NONE',
  'AdminController.getPaymentsStats': 'NONE',
  'AdminController.getPendingVendors': 'NONE',
  'AdminController.getUserById': 'NONE',
  'AdminController.listPayments': 'NONE',
  'AdminController.listReferralRewards': 'NONE',
  'AdminController.reviewReferralReward': 'FINANCE_EXECUTE',
  'AdminController.suspendVendor': 'NONE',
  'AdminController.unbanUser': 'USER_ROLES',
  'AdminController.unsuspendVendor': 'NONE',
  'AdminController.updateUserRole': 'USER_ROLES',
  'AdminDeliveryFailureController.conclude': 'FINANCE_EXECUTE',
  'AdminDeliveryFailureController.evidence': 'NONE',
  'AdminDeliveryTariffsController.create': 'SETTINGS',
  'AdminDeliveryTariffsController.findOne': 'NONE',
  'AdminDeliveryTariffsController.list': 'NONE',
  'AdminDeliveryTariffsController.publish': 'SETTINGS',
  'AdminDeliveryTariffsController.readiness': 'NONE',
  'AdminDeliveryTariffsController.remove': 'SETTINGS',
  'AdminDeliveryTariffsController.simulate': 'NONE',
  'AdminDeliveryTariffsController.update': 'SETTINGS',
  'AdminDriversController.activate': 'NONE',
  'AdminDriversController.create': 'NONE',
  'AdminDriversController.deactivate': 'NONE',
  'AdminDriversController.findAll': 'NONE',
  'AdminDriversController.findOne': 'NONE',
  'AdminDriversController.resendInvitation': 'NONE',
  'AdminDriversController.update': 'NONE',
  'AdminDriverSettlementsController.cancel': 'FINANCE_EXECUTE',
  // Lot 3 — détail des courses (lecture ; le livreur n'y a jamais accès).
  'AdminDriverSettlementsController.courses': 'NONE',
  'AdminDriverSettlementsController.list': 'NONE',
  'AdminDriverSettlementsController.outstanding': 'NONE',
  'AdminDriverSettlementsController.record': 'FINANCE_EXECUTE',
  // Lot 2 (30/10/2026) — grand livre. Lecture pour tout administrateur ;
  // écrire au grand livre (rattrapage, contre-passation, exclusion,
  // arbitrage) fixe ce que Lilia doit à chacun : FINANCE_EXECUTE.
  'AdminLedgerController.balances': 'NONE',
  'AdminLedgerController.catchUp': 'FINANCE_EXECUTE',
  'AdminLedgerController.exceptions': 'NONE',
  'AdminLedgerController.excludeOrder': 'FINANCE_EXECUTE',
  'AdminLedgerController.resolveException': 'FINANCE_EXECUTE',
  'AdminLedgerController.reverse': 'FINANCE_EXECUTE',
  'AdminLedgerController.vendorBalance': 'NONE',
  'AdminOrderRefundsController.create': 'FINANCE_EXECUTE',
  'AdminOrderRefundsController.quote': 'NONE',
  'AdminPayoutController.getFinancials': 'NONE',
  'AdminPayoutController.listPayouts': 'NONE',
  'AdminPayoutController.payoutEvents': 'NONE',
  'AdminPayoutController.pendingSummary': 'NONE',
  'AdminPayoutController.requestPayout': 'FINANCE_EXECUTE',
  'AdminPayoutController.retryPayout': 'FINANCE_EXECUTE',
  'AdminPayoutController.updatePayoutAccount': 'FINANCE_EXECUTE',
  'AdminPayoutController.vendorPayoutAccounts': 'NONE',
  'AdminPayoutController.webhookHealth': 'NONE',
  // 1B — la remise forcée d'un retrait ouvre un versement vendeur.
  'AdminPickupArbitrationController.arbitrate': 'FINANCE_EXECUTE',
  'AdminPublicHolidaysController.create': 'NONE',
  // Lot 2 — rapprochement. Importer, scanner ou résoudre ouvre ou lève un
  // blocage des versements : FINANCE_EXECUTE. Une note ne change rien.
  'AdminReconciliationController.addNote': 'NONE',
  'AdminReconciliationController.getItem': 'NONE',
  'AdminReconciliationController.importExport': 'FINANCE_EXECUTE',
  'AdminReconciliationController.listItems': 'NONE',
  'AdminReconciliationController.listRuns': 'NONE',
  'AdminReconciliationController.resolve': 'FINANCE_EXECUTE',
  'AdminReconciliationController.scan': 'FINANCE_EXECUTE',
  'AdminReconciliationController.summary': 'NONE',
  // Lot 3 (point 7) — membres d'une boutique. Ajouter ou révoquer donne ou
  // retire un accès : USER_ROLES pour un administrateur (le propriétaire,
  // RESTAURATEUR, passe par la permission MEMBERS vérifiée dans le service).
  'ShopMembershipController.add': 'USER_ROLES',
  'ShopMembershipController.list': 'NONE',
  'ShopMembershipController.revoke': 'USER_ROLES',
  'AdminPublicHolidaysController.list': 'NONE',
  'AdminPublicHolidaysController.remove': 'NONE',
  // F3-11 — l'arrêt d'une offre vendeur est un réglage commercial, comme
  // activer ou désactiver un code promo : aucun argent ne part.
  'AdminVendorOffersController.list': 'NONE',
  'AdminVendorOffersController.stop': 'SETTINGS',
  'AdminVendorOnboardingController.activate': 'NONE',
  // F-03 (audit du 28/10/2026) — lecture seule, aucune donnée financière.
  'AdminVendorReachabilityController.list': 'NONE',
  'AdminVendorOnboardingController.create': 'NONE',
  'AdminVendorOnboardingController.resendInvitation': 'NONE',
  'AdminVendorOnboardingController.setDisplayOrder': 'NONE',
  'AdminVendorOnboardingController.setFeatured': 'NONE',
  'AdminVendorOnboardingController.updateCommerce': 'FINANCE_EXECUTE',
  // Premium (Lot 2) — enregistrer ou révoquer un mois payé fixe ce qu'un
  // vendeur a acheté (décision du 11/10/2026 : FINANCE_EXECUTE seul).
  'AdminVendorSubscriptionsController.grant': 'FINANCE_EXECUTE',
  'AdminVendorSubscriptionsController.list': 'NONE',
  'AdminVendorSubscriptionsController.revoke': 'FINANCE_EXECUTE',
  'ApprovalsController.admins': 'NONE',
  'ApprovalsController.approve': 'FINANCE_APPROVE',
  'ApprovalsController.list': 'NONE',
  'ApprovalsController.reject': 'NONE',
  'ApprovalsController.requestCapabilities': 'USER_ROLES',
  'BannersController.create': 'NONE',
  'BannersController.remove': 'NONE',
  'BannersController.reorder': 'NONE',
  'BannersController.update': 'NONE',
  'CategoriesController.create': 'NONE',
  'CategoriesController.findAll': 'NONE',
  'CategoriesController.findOne': 'NONE',
  'CategoriesController.remove': 'NONE',
  'CategoriesController.reorder': 'NONE',
  'CategoriesController.update': 'NONE',
  'ClaimsController.findOne': 'NONE',
  'ClaimsController.list': 'NONE',
  'ClaimsController.postMessage': 'NONE',
  'ClaimsController.reject': 'NONE',
  'ClaimsController.voucher': 'FINANCE_EXECUTE',
  'CloudinaryController.uploadImage': 'NONE',
  'DashboardController.getClientDetail': 'NONE',
  'DashboardController.getClientStats': 'NONE',
  'DashboardController.getOrderStats': 'NONE',
  'DashboardController.getOverview': 'NONE',
  'DashboardController.getPeakHours': 'NONE',
  'DashboardController.getRestaurantRanking': 'NONE',
  'DashboardController.getRevenueChart': 'NONE',
  'DashboardController.getTopProducts': 'NONE',
  'DashboardController.getVendorStats': 'NONE',
  'DeliveriesController.assignDeliverer': 'NONE',
  'DeliveriesController.assignDelivererToOrder': 'NONE',
  'DeliveriesController.findAllForRestaurant': 'NONE',
  'DeliveriesController.findAssignmentHistory': 'NONE',
  'DeliveriesController.findByOrderId': 'NONE',
  'DeliveriesController.findOne': 'NONE',
  'DeliveriesController.getAvailableDeliverers': 'NONE',
  'DeliveriesController.updateStatus': 'NONE',
  'DeliveryFailureController.declare': 'NONE',
  'DeliveryReviewsController.create': 'NONE',
  'DeliveryReviewsController.findByDelivery': 'NONE',
  'DeliveryReviewsController.getDelivererStats': 'NONE',
  'DeliveryTariffsController.current': 'NONE',
  'IncidentsController.create': 'NONE',
  'IncidentsController.findAll': 'NONE',
  'IncidentsController.findOne': 'NONE',
  'IncidentsController.update': 'NONE',
  'MenuImagesController.create': 'NONE',
  'MenuImagesController.listMine': 'NONE',
  'MenuImagesController.remove': 'NONE',
  'MenuImagesController.reorder': 'NONE',
  'MenuImagesController.update': 'NONE',
  // F3-09 — éditeur d'options : écritures de catalogue, aucun argent en jeu.
  'ModifiersController.attach': 'NONE',
  'ModifiersController.availability': 'NONE',
  'ModifiersController.create': 'NONE',
  'ModifiersController.list': 'NONE',
  'ModifiersController.remove': 'NONE',
  'ModifiersController.reorder': 'NONE',
  'ModifiersController.update': 'NONE',
  'MenusController.create': 'NONE',
  'MenusController.findAllForAdmin': 'NONE',
  'MenusController.findByRestaurant': 'NONE',
  'MenusController.remove': 'NONE',
  'MenusController.toggleActive': 'NONE',
  'MenusController.update': 'NONE',
  'MenusController.updateStock': 'NONE',
  'OpsController.getQueue': 'NONE',
  'OrdersController.acceptOrder': 'NONE',
  'OrdersController.getPendingOrdersCount': 'NONE',
  'OrdersController.getReceipt': 'NONE',
  // Lot 2 — lecture d'une commande par le personnel, même portée que la liste.
  'OrdersController.getRestaurantOrder': 'NONE',
  'OrdersController.getRestaurantOrders': 'NONE',
  'OrdersController.getStuckOrders': 'NONE',
  'OrdersController.getUserOrders': 'NONE',
  'OrdersController.rejectOrder': 'NONE',
  'OrdersController.updateOrderStatus': 'NONE',
  'PaymentController.confirmPayment': 'FINANCE_EXECUTE',
  'PaymentController.paymentEvents': 'NONE',
  'PaymentController.reconcile': 'NONE',
  'PaymentController.rejectPayment': 'FINANCE_EXECUTE',
  'PlatformSettingsController.get': 'NONE',
  'PlatformSettingsController.update': 'SETTINGS',
  'ProductImagesController.create': 'NONE',
  'ProductImagesController.listMine': 'NONE',
  'ProductImagesController.remove': 'NONE',
  'ProductImagesController.reorder': 'NONE',
  'ProductImagesController.update': 'NONE',
  'ProductsController.create': 'NONE',
  'ProductsController.findAllForOwner': 'NONE',
  'ProductsController.remove': 'NONE',
  'ProductsController.reorder': 'NONE',
  'ProductsController.setAvailability': 'NONE',
  'ProductsController.update': 'NONE',
  'ProductsController.updateStock': 'NONE',
  'PromoController.create': 'SETTINGS',
  'PromoController.findAll': 'NONE',
  'PromoController.remove': 'SETTINGS',
  'PromoController.stats': 'NONE',
  'PromoController.toggle': 'SETTINGS',
  'PromoController.validate': 'NONE',
  // R-09 — réglages qui fixent de l'argent : demande à deux administrateurs.
  'SettingsApprovalsController.requestPlatformChange': 'FINANCE_EXECUTE',
  'SettingsApprovalsController.requestVendorCommissionChange':
    'FINANCE_EXECUTE',
  'QuartiersController.addQuartiersToZone': 'NONE',
  'QuartiersController.createDeliveryZone': 'NONE',
  'QuartiersController.deleteDeliveryZone': 'NONE',
  'QuartiersController.getMyDeliveryZones': 'NONE',
  'QuartiersController.removeQuartiersFromZone': 'NONE',
  'QuartiersController.seedQuartiers': 'NONE',
  'QuartiersController.setCentroid': 'NONE',
  'QuartiersController.updateDeliveryZone': 'NONE',
  'RefundsController.execute': 'FINANCE_EXECUTE',
  'RefundsController.findOne': 'NONE',
  'RefundsController.list': 'NONE',
  'RefundsController.updateStatus': 'FINANCE_EXECUTE',
  'RestaurantsController.addSpecialty': 'NONE',
  'RestaurantsController.countOrders': 'NONE',
  'RestaurantsController.create': 'NONE',
  'RestaurantsController.findClients': 'NONE',
  'RestaurantsController.findMine': 'NONE',
  'RestaurantsController.getClientOrders': 'NONE',
  'RestaurantsController.removeSpecialty': 'NONE',
  'RestaurantsController.setOperatingHours': 'NONE',
  'RestaurantsController.updateDeliverySettings': 'NONE',
  'RestaurantsController.updateOpenStatus': 'NONE',
  'RestaurantsController.updateOperatingHour': 'NONE',
  'RestaurantsController.updateRestaurant': 'NONE',
  'ScheduleController.checkHours': 'NONE',
  'ScheduleController.resetStock': 'NONE',
  'SmsController.sendTest': 'NONE',
  'VendorClosuresController.closedOnHolidays': 'NONE',
  'VendorClosuresController.create': 'NONE',
  'VendorClosuresController.list': 'NONE',
  'VendorClosuresController.opening': 'NONE',
  'VendorClosuresController.pause': 'NONE',
  'VendorClosuresController.remove': 'NONE',
  'VendorClosuresController.resume': 'NONE',
  'VendorOnboardingController.getDeliveryZones': 'NONE',
  'VendorOnboardingController.getOnboarding': 'NONE',
  'VendorOnboardingController.getPreview': 'NONE',
  'VendorOnboardingController.simulateDeliverySubsidy': 'NONE',
  'VendorOnboardingController.updateDelivery': 'NONE',
  'VendorOnboardingController.updateDeliverySubsidy': 'NONE',
  'VendorOnboardingController.updateHours': 'NONE',
  'VendorOnboardingController.updateIdentity': 'NONE',
  'VendorOnboardingController.updateLocation': 'NONE',
  'VendorPhotosController.create': 'NONE',
  'VendorPhotosController.listMine': 'NONE',
  'VendorPhotosController.remove': 'NONE',
  'VendorPhotosController.reorder': 'NONE',
  'VendorPhotosController.update': 'NONE',
  'VendorsController.approve': 'NONE',
  'VendorsController.create': 'NONE',
  'VendorsController.updateProfile': 'NONE',
};

/**
 * Lot 1C (ADM-05, D-2) — gestes ADMIN sensibles sans capacité financière :
 * second facteur exigé (`@RequireSecondFactor`, interrupteur
 * `ADMIN_SECOND_FACTOR_ENFORCED`). Liste validée le 22/10/2026. Toute route
 * ajoutée ou retirée du décorateur doit l'être ici, et inversement.
 */
const SECOND_FACTOR_ROUTES: readonly string[] = [
  // Commandes (ADMIN seulement ; le vendeur n'est pas concerné)
  'OrdersController.acceptOrder',
  'OrdersController.rejectOrder',
  'OrdersController.updateOrderStatus',
  // Vendeurs
  'AdminController.approveVendor',
  'AdminController.createRestaurantWithOwner',
  'AdminController.deleteReview',
  'AdminController.suspendVendor',
  'AdminController.unsuspendVendor',
  'AdminVendorOnboardingController.activate',
  'AdminVendorOnboardingController.create',
  'AdminVendorOnboardingController.resendInvitation',
  'VendorsController.approve',
  // Livreurs
  'AdminDriversController.activate',
  'AdminDriversController.create',
  'AdminDriversController.deactivate',
  'AdminDriversController.resendInvitation',
  'AdminDriversController.update',
  // Livraisons
  'DeliveriesController.assignDeliverer',
  'DeliveriesController.assignDelivererToOrder',
  'DeliveriesController.updateStatus',
  'DeliveryFailureController.declare',
  // Arbitrages
  'ApprovalsController.reject',
  'ClaimsController.reject',
  // Paiements
  'PaymentController.reconcile',
  // Exploitation
  'AdminPublicHolidaysController.create',
  'AdminPublicHolidaysController.remove',
  'QuartiersController.seedQuartiers',
  'QuartiersController.setCentroid',
  'ScheduleController.resetStock',
  'SmsController.sendTest',
];

describe('Second facteur sur les gestes ADMIN sensibles (Lot 1C)', () => {
  const routes = collectAdminRoutes();

  it('le décorateur et la liste coïncident exactement', () => {
    const marked = routes
      .filter((r) => r.secondFactor)
      .map((r) => r.key)
      .sort();
    expect(marked).toEqual([...SECOND_FACTOR_ROUTES].sort());
  });

  it('aucune route à capacité ne porte aussi le marqueur (la capacité fait déjà mieux)', () => {
    expect(
      routes.filter((r) => r.secondFactor && r.capability).map((r) => r.key),
    ).toEqual([]);
  });

  it('chaque route de la liste est ouverte à l’ADMIN et classée NONE', () => {
    for (const key of SECOND_FACTOR_ROUTES) {
      expect(ADMIN_ROUTE_CAPABILITIES[key]).toBe('NONE');
    }
  });
});

describe('Classement des routes ADMIN (F3-08)', () => {
  const routes = collectAdminRoutes();

  it('aucune route ADMIN non classée, aucune entrée orpheline', () => {
    const actual = routes.map((r) => r.key);
    expect(actual.filter((k) => !(k in ADMIN_ROUTE_CAPABILITIES))).toEqual([]);
    expect(
      Object.keys(ADMIN_ROUTE_CAPABILITIES).filter((k) => !actual.includes(k)),
    ).toEqual([]);
  });

  it('chaque route porte exactement la capacité de la table', () => {
    const mismatches = routes
      .filter(
        (r) => (r.capability ?? 'NONE') !== ADMIN_ROUTE_CAPABILITIES[r.key],
      )
      .map((r) => `${r.key} : ${r.capability ?? 'NONE'}`);
    expect(mismatches).toEqual([]);
  });

  it('les gestes qui font partir de l’argent exigent FINANCE_EXECUTE', () => {
    for (const key of [
      'AdminPayoutController.requestPayout',
      'AdminPayoutController.updatePayoutAccount',
      'RefundsController.execute',
      'ClaimsController.voucher',
      'PaymentController.confirmPayment',
    ]) {
      expect(ADMIN_ROUTE_CAPABILITIES[key]).toBe('FINANCE_EXECUTE');
    }
  });
});
