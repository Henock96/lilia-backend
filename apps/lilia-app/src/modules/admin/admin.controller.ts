import {
  Body,
  Controller,
  Get,
  HttpStatus,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Delete,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Role, User } from '@prisma/client';

import { AdminService } from './admin.service';
import { CreateRestaurantWithOwnerDto } from './dto/create-restaurant-with-owner.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { GetDelivererMissionsQueryDto } from './dto/get-deliverer-missions.dto';
import { AdminVendorFilterDto } from './dto/admin-vendor-filter.dto';
import { SuspendVendorDto } from './dto/suspend-vendor.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Toutes les routes sont ADMIN-only.
 * @Roles('ADMIN') au niveau controller s'applique à toutes les routes.
 * Guards globaux (APP_GUARD) actifs — pas besoin de @UseGuards().
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly firebaseService: FirebaseService, // pour révoquer les tokens
  ) {}

  // ─── DASHBOARD ─────────────────────────────────────────────────────────────

  @Get('dashboard')
  @ApiOperation({ summary: 'Statistiques globales du tableau de bord' })
  getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  // ─── RESTAURANTS ───────────────────────────────────────────────────────────

  @Get('restaurants')
  @ApiOperation({ summary: 'Tous les restaurants (actifs et inactifs)' })
  getAllRestaurants() {
    return this.adminService.getAllRestaurants();
  }

  @Post('restaurants')
  @ApiOperation({ summary: 'Créer un restaurant avec son propriétaire' })
  async createRestaurantWithOwner(@Body() dto: CreateRestaurantWithOwnerDto) {
    return this.adminService.createRestaurantWithOwner(dto);
  }

  @Patch('restaurants/:id/toggle-active')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activer / désactiver un restaurant' })
  @ApiParam({ name: 'id', description: 'ID du restaurant' })
  async toggleRestaurantActive(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
  ) {
    return this.adminService.toggleRestaurantActive(id, isActive);
  }

  // ─── VENDORS (marketplace multi-vendeurs) ──────────────────────────────────
  // Vue admin complète : inclut les vendeurs non approuvés et désactivés
  // (la route publique /vendors filtre uniquement les approuvés actifs).

  @Get('vendors')
  @ApiOperation({
    summary: 'Tous les vendeurs (admin), filtrables par type / statut',
  })
  @ApiQuery({ name: 'vendorType', required: false })
  @ApiQuery({ name: 'adminApproved', required: false, type: Boolean })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getAllVendors(@Query() dto: AdminVendorFilterDto) {
    return this.adminService.getAllVendors(dto);
  }

  @Get('vendors/pending')
  @ApiOperation({ summary: 'Vendeurs en attente de validation' })
  getPendingVendors() {
    return this.adminService.getPendingVendors();
  }

  @Patch('vendors/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approuver un vendeur en attente' })
  @ApiParam({ name: 'id', description: 'ID du vendeur (Restaurant)' })
  approveVendor(@Param('id') id: string, @CurrentUser() admin: User) {
    return this.adminService.approveVendor(id, admin.id);
  }

  @Patch('vendors/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspendre un vendeur (isActive=false, raison obligatoire)',
  })
  @ApiParam({ name: 'id', description: 'ID du vendeur (Restaurant)' })
  suspendVendor(
    @Param('id') id: string,
    @Body() dto: SuspendVendorDto,
    @CurrentUser() admin: User,
  ) {
    return this.adminService.suspendVendor(id, dto.reason, admin.id);
  }

  @Patch('vendors/:id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réactiver un vendeur suspendu (isActive=true)' })
  @ApiParam({ name: 'id', description: 'ID du vendeur (Restaurant)' })
  activateVendor(@Param('id') id: string, @CurrentUser() admin: User) {
    return this.adminService.activateVendor(id, admin.id);
  }

  // ─── UTILISATEURS ──────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'Tous les utilisateurs, filtrables par rôle' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'role', required: false, enum: Role })
  getAllUsers(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('role') role?: Role,
  ) {
    return this.adminService.getAllUsers(
      parseInt(page, 10),
      parseInt(limit, 10),
      role,
    );
  }

  @Get('clients')
  @ApiOperation({ summary: 'Clients uniquement (paginés, recherche optionnelle)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  getAllClients(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('search') search?: string,
  ) {
    return this.adminService.getAllClients(
      parseInt(page, 10),
      parseInt(limit, 10),
      search,
    );
  }

  @Get('clients/:id/loyalty')
  @ApiOperation({ summary: "Solde et historique de fidélité d'un client" })
  @ApiParam({ name: 'id', description: 'ID Prisma du client' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getClientLoyalty(
    @Param('id') id: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.adminService.getClientLoyalty(
      id,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  @Get('clients/:id/referral')
  @ApiOperation({ summary: "Statistiques de parrainage d'un client" })
  @ApiParam({ name: 'id', description: 'ID Prisma du client' })
  getClientReferral(@Param('id') id: string) {
    return this.adminService.getClientReferral(id);
  }

  @Patch('users/:id/role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Changer le rôle d'un utilisateur" })
  @ApiParam({ name: 'id', description: "ID Prisma de l'utilisateur" })
  updateUserRole(@Param('id') id: string, @Body() dto: UpdateUserRoleDto) {
    return this.adminService.updateUserRole(id, dto);
  }

  /**
   * Banni un utilisateur ET révoque ses tokens Firebase.
   * Après révocation, le prochain appel API avec son token
   * sera bloqué par verifyIdToken(token, checkRevoked: true).
   *
   * Note : pour activer checkRevoked, il faut un guard dédié sur les
   * routes sensibles — le guard standard n'active pas checkRevoked
   * pour des raisons de performance.
   */
  @Patch('users/:id/ban')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bannir un utilisateur et révoquer ses tokens Firebase',
    description:
      "Révoque immédiatement les refresh tokens Firebase. L'ID token actuel reste valide jusqu'à expiration (1h max).",
  })
  async banUser(@Param('id') id: string, @Body() dto: BanUserDto) {
    const { firebaseUid } = await this.adminService.banUser(id, dto.reason);

    // Révocation Firebase — bloque le renouvellement du token
    await this.firebaseService.revokeUserTokens(firebaseUid);

    return { message: 'Utilisateur banni et tokens révoqués' };
  }

  // ─── LIVREURS ──────────────────────────────────────────────────────────────

  @Get('deliverers')
  @ApiOperation({ summary: 'Tous les livreurs avec leurs livraisons récentes' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getAllDeliverers(@Query('page') page = '1', @Query('limit') limit = '20') {
    return this.adminService.getAllDeliverers(
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  @Get('deliverers/:id/stats')
  @ApiOperation({
    summary: 'Statistiques agrégées d\'un livreur (succès, revenu, durée moyenne)',
  })
  @ApiParam({ name: 'id', description: 'ID Prisma du livreur' })
  getDelivererStats(@Param('id') id: string) {
    return this.adminService.getDelivererStats(id);
  }

  @Get('deliverers/:id/missions')
  @ApiOperation({ summary: 'Historique paginé des missions d\'un livreur' })
  @ApiParam({ name: 'id', description: 'ID Prisma du livreur' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['EN_ATTENTE', 'EN_TRANSIT', 'LIVRER', 'ECHEC'],
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getDelivererMissions(
    @Param('id') id: string,
    @Query() query: GetDelivererMissionsQueryDto,
  ) {
    return this.adminService.getDelivererMissions(
      id,
      query.status,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  // ─── COMMANDES ─────────────────────────────────────────────────────────────

  @Get('orders')
  @ApiOperation({
    summary: 'Toutes les commandes avec filtre optionnel par statut',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  getAllOrders(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
  ) {
    return this.adminService.getAllOrders(
      parseInt(page, 10),
      parseInt(limit, 10),
      status,
    );
  }

  @Get('orders/active')
  @ApiOperation({ summary: 'Commandes en cours (supervision temps réel)' })
  getActiveOrders() {
    return this.adminService.getActiveOrders();
  }

  // ─── PAIEMENTS ─────────────────────────────────────────────────────────────

  @Get('payments')
  @ApiOperation({
    summary:
      'Paiements pour supervision — omettre `status` pour la vue "Tous"',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      "PENDING | SUCCESS | FAILED | CANCELLED. Vide ou absent = tous statuts.",
  })
  listPayments(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
  ) {
    return this.adminService.listPayments(
      parseInt(page, 10),
      parseInt(limit, 10),
      status,
    );
  }

  @Get('payments/stats')
  @ApiOperation({
    summary:
      'KPI paiements (pending à confirmer, encaissé ce mois, 7 derniers jours)',
  })
  getPaymentsStats() {
    return this.adminService.getPaymentsStats();
  }

  // ─── AVIS ──────────────────────────────────────────────────────────────────

  @Get('reviews')
  @ApiOperation({ summary: 'Tous les avis (modération)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getAllReviews(@Query('page') page = '1', @Query('limit') limit = '20') {
    return this.adminService.getAllReviews(
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  @Delete('reviews/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un avis (modération)' })
  @ApiParam({ name: 'id', description: "ID de l'avis" })
  deleteReview(@Param('id') id: string) {
    return this.adminService.deleteReview(id);
  }
}
