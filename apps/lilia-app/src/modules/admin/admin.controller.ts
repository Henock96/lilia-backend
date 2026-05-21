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
import { Role } from '@prisma/client';

import { AdminService } from './admin.service';
import { CreateRestaurantWithOwnerDto } from './dto/create-restaurant-with-owner.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { Roles } from '../auth/decorators/roles.decorator';
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
  @ApiOperation({ summary: 'Paiements (par défaut PENDING) pour supervision' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  getPendingPayments(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
  ) {
    return this.adminService.getPendingPayments(
      parseInt(page, 10),
      parseInt(limit, 10),
      status,
    );
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
