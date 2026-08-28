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
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

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
  getAllUsers(@Query() query: PaginationQueryDto, @Query('role') role?: Role) {
    return this.adminService.getAllUsers(query.page, query.limit, role);
  }

  @Get('clients')
  @ApiOperation({
    summary: 'Clients uniquement (paginés, recherche optionnelle)',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  getAllClients(
    @Query() query: PaginationQueryDto,
    @Query('search') search?: string,
  ) {
    return this.adminService.getAllClients(query.page, query.limit, search);
  }

  @Get('clients/:id/loyalty')
  @ApiOperation({ summary: "Solde et historique de fidélité d'un client" })
  @ApiParam({ name: 'id', description: 'ID Prisma du client' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getClientLoyalty(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.adminService.getClientLoyalty(id, query.page, query.limit);
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
   * Bannit un utilisateur. Trois effets, tous nécessaires :
   *
   * 1. `statusUser = BLOCKED` en base → `RolesGuard` rejette toute route
   *    authentifiée et `TrackingGateway` éjecte la session WebSocket ;
   * 2. compte Firebase `disabled: true` → il ne peut plus se reconnecter
   *    (sans ça, il suffisait de fermer l'app et de se relogger) ;
   * 3. refresh tokens révoqués → plus de renouvellement du token courant.
   *
   * L'ID token déjà émis reste techniquement valide jusqu'à expiration (1 h),
   * mais le point 1 le rend inopérant sur toutes les routes dès la requête
   * suivante.
   */
  @Patch('users/:id/ban')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bannir un utilisateur (statut, compte Firebase et tokens)',
    description:
      'Passe statusUser à BLOCKED, désactive le compte Firebase et révoque ' +
      'ses refresh tokens. Effet immédiat sur toutes les routes authentifiées.',
  })
  async banUser(@Param('id') id: string, @Body() dto: BanUserDto) {
    const { firebaseUid, cacheInvalidated } = await this.adminService.banUser(
      id,
      dto.reason,
    );

    // Désactivation du compte : empêche la ré-authentification.
    await this.firebaseService.setUserDisabled(firebaseUid, true);
    // Révocation : bloque le renouvellement du token courant.
    await this.firebaseService.revokeUserTokens(firebaseUid);

    return {
      message: cacheInvalidated
        ? 'Utilisateur banni, compte Firebase désactivé et tokens révoqués'
        : 'Utilisateur banni, mais le cache n’a pas pu être purgé : ' +
          'le blocage peut mettre jusqu’à 5 minutes à s’appliquer',
    };
  }

  @Patch('users/:id/unban')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lever le bannissement d’un utilisateur',
    description:
      'Repasse statusUser à ACTIVE et réactive le compte Firebase. ' +
      "L'utilisateur devra se reconnecter (ses tokens ont été révoqués).",
  })
  async unbanUser(@Param('id') id: string) {
    const { firebaseUid, cacheInvalidated } =
      await this.adminService.unbanUser(id);

    await this.firebaseService.setUserDisabled(firebaseUid, false);

    return {
      message: cacheInvalidated
        ? 'Bannissement levé, compte Firebase réactivé'
        : 'Bannissement levé, mais le cache n’a pas pu être purgé : ' +
          'la réactivation peut mettre jusqu’à 5 minutes à s’appliquer',
    };
  }

  // ─── LIVREURS ──────────────────────────────────────────────────────────────

  @Get('deliverers')
  @ApiOperation({ summary: 'Tous les livreurs avec leurs livraisons récentes' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getAllDeliverers(@Query() query: PaginationQueryDto) {
    return this.adminService.getAllDeliverers(query.page, query.limit);
  }

  @Get('deliverers/:id/stats')
  @ApiOperation({
    summary:
      "Statistiques agrégées d'un livreur (succès, revenu, durée moyenne)",
  })
  @ApiParam({ name: 'id', description: 'ID Prisma du livreur' })
  getDelivererStats(@Param('id') id: string) {
    return this.adminService.getDelivererStats(id);
  }

  @Get('deliverers/:id/missions')
  @ApiOperation({ summary: "Historique paginé des missions d'un livreur" })
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
    @Query() query: PaginationQueryDto,
    @Query('status') status?: string,
  ) {
    return this.adminService.getAllOrders(query.page, query.limit, status);
  }

  @Get('orders/active')
  @ApiOperation({ summary: 'Commandes en cours (supervision temps réel)' })
  getActiveOrders() {
    return this.adminService.getActiveOrders();
  }

  // ─── PAIEMENTS ─────────────────────────────────────────────────────────────

  @Get('payments')
  @ApiOperation({
    summary: 'Paiements pour supervision — omettre `status` pour la vue "Tous"',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      'PENDING | SUCCESS | FAILED | CANCELLED. Vide ou absent = tous statuts.',
  })
  listPayments(
    @Query() query: PaginationQueryDto,
    @Query('status') status?: string,
  ) {
    return this.adminService.listPayments(query.page, query.limit, status);
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
  getAllReviews(@Query() query: PaginationQueryDto) {
    return this.adminService.getAllReviews(query.page, query.limit);
  }

  @Delete('reviews/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un avis (modération)' })
  @ApiParam({ name: 'id', description: "ID de l'avis" })
  deleteReview(@Param('id') id: string) {
    return this.adminService.deleteReview(id);
  }
}
