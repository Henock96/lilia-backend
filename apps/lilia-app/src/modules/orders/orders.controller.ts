import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Patch,
  Delete,
  HttpCode,
  Query,
  HttpStatus,
  Headers,
  UseGuards,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { OrderReceiptService } from './order-receipt.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DecodedIdToken } from 'firebase-admin/auth';
import { User } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { MaintenanceGuard } from '../platform-settings/guards/maintenance.guard';

/**
 * Guards globaux actifs sur toutes les routes (via APP_GUARD dans AuthModule) :
 *   1. FirebaseAuthGuard  → vérifie le Bearer token, peuple request.firebaseUser
 *   2. RolesGuard         → si @Roles() présent, vérifie le rôle et peuple request.user
 *
 * @FirebaseUser() → DecodedIdToken Firebase (uid, email…)
 * @CurrentUser()  → User Prisma complet (id, role…) — disponible après @Roles()
 *
 * Convention routes :
 *   /orders/my           → commandes du client connecté
 *   /orders/restaurant   → commandes du restaurant du restaurateur connecté
 *   /orders/user/:userId → commandes d'un user (ADMIN seulement)
 *   /orders/:id/*        → actions sur une commande spécifique
 */
@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly orderReceiptService: OrderReceiptService,
  ) {}
  // ─── CRÉATION ──────────────────────────────────────────────────────────────

  /**
   * Crée une commande depuis le panier actuel du client.
   * On utilise firebaseUid (du token) car le service le requiert pour retrouver le user.
   * firebaseUser.uid est la source de vérité — jamais le body.
   */
  @Post('checkout')
  @UseGuards(MaintenanceGuard)
  @ApiOperation({ summary: 'Créer une commande depuis le panier' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiResponse({ status: 400, description: 'Panier vide ou restaurant fermé' })
  createOrder(
    @FirebaseUser() firebaseUser: DecodedIdToken,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() createOrderDto: CreateOrderDto,
  ) {
    return this.ordersService.createOrderFromCart(
      firebaseUser.uid,
      createOrderDto,
      idempotencyKey,
    );
  }
  // ─── LECTURE ───────────────────────────────────────────────────────────────

  /**
   * Commandes du client connecté — paginées.
   * parseInt avec fallback pour éviter NaN si query absent.
   */
  //@Get('users')
  @Get('my')
  @ApiOperation({ summary: 'Mes commandes (client)' })
  getMyOrders(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
  ) {
    return this.ordersService.findOrdersClient(
      parseInt(page, 10),
      parseInt(limit, 10),
      fbUser.uid,
    );
  }
  /**
   * Commandes reçues par le restaurant du restaurateur connecté.
   * L'ADMIN voit toutes les commandes de tous les restaurants.
   */
  @Get('restaurant')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Commandes reçues (restaurateur / admin)' })
  getRestaurantOrders(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.ordersService.findRestaurantOrders(
      fbUser.uid,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }
  /**
   * Commandes d'un utilisateur spécifique — ADMIN uniquement.
   * Route déplacée depuis UserController où elle n'avait pas sa place.
   */
  @Get('user/:userId')
  @Roles('ADMIN')
  @ApiOperation({ summary: "Commandes d'un utilisateur (admin)" })
  @ApiParam({ name: 'userId', description: "ID Prisma de l'utilisateur" })
  getUserOrders(@Param('userId') userId: string, @CurrentUser() caller: User) {
    // findOrdersClient attend un firebaseUid — on ajoute une méthode par ID Prisma
    return this.ordersService.findOrdersByUserId(userId, caller);
  }

  /**
   * Détail d'une commande — accessible par son propriétaire ou un admin.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Détail d\'une commande' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({ status: 200, description: 'Commande trouvée' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  getOrder(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.ordersService.findOrderById(id, fbUser.uid);
  }

  /**
   * Reçu PDF d'une commande payée — propriétaire ou ADMIN.
   * StreamableFile est exclu du wrapping { data } par l'intercepteur global.
   */
  @Get(':id/receipt')
  @Roles('CLIENT', 'ADMIN', 'RESTAURATEUR')
  @ApiOperation({ summary: "Télécharger le reçu PDF d'une commande payée" })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({ status: 200, description: 'PDF du reçu' })
  @ApiResponse({ status: 400, description: 'Commande non payée ou annulée' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  async getReceipt(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ): Promise<StreamableFile> {
    const { buffer, numero } = await this.orderReceiptService.generateReceipt(
      id,
      user,
    );
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="recu-${numero}.pdf"`,
    });
  }

  /**
   * Annulation par le client — uniquement depuis EN_ATTENTE.
   * La state machine dans OrdersService valide la transition.
   */
  @Patch(':id/cancel')
  @Roles('CLIENT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Annuler une commande (client)' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({ status: 200, description: 'Commande annulée' })
  @ApiResponse({ status: 400, description: 'Transition de statut invalide' })
  cancelOrder(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.ordersService.cancelOrder(id, fbUser.uid);
  }

  /**
   * Mise à jour de statut par le restaurateur ou l'admin.
   * La state machine valide que la transition est légale
   * et que l'acteur a le droit de la faire.
   */
  @Patch(':id/status')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le statut (restaurateur / admin)' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({ status: 200, description: 'Statut mis à jour' })
  @ApiResponse({ status: 400, description: 'Transition invalide' })
  @ApiResponse({ status: 403, description: 'Commande hors restaurant' })
  updateOrderStatus(
    @Param('id') id: string,
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body() updateOrderStatusDto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateOrderStatusByRestaurateur(
      id,
      fbUser.uid,
      updateOrderStatusDto.status,
    );
  }

  /**
   * Soft-delete d'une commande annulée — masque côté client.
   * Seul le propriétaire de la commande peut la supprimer.
   */
  @Delete(':id')
  @Roles('CLIENT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer une commande annulée (client)' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({ status: 200, description: 'Commande supprimée' })
  @ApiResponse({ status: 400, description: 'Commande non annulée' })
  deleteOrder(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.ordersService.deleteOrder(id, fbUser.uid);
  }

  // ─── REORDER ───────────────────────────────────────────────────────────────

  @Post(':id/reorder')
  @ApiOperation({
    summary: 'Recommander une commande précédente',
    description:
      "Ajoute tous les produits d'une commande précédente au panier. " +
      'Les produits indisponibles sont ignorés.',
  })
  @ApiParam({ name: 'id', description: 'ID de la commande à recommander' })
  @ApiResponse({ status: 201, description: 'Commande ajoutée au panier' })
  @ApiResponse({ status: 400, description: "Panier d'un autre restaurant" })
  @ApiResponse({ status: 403, description: 'Commande non autorisée' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  reorder(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.ordersService.reorderFromPreviousOrder(id, fbUser.uid);
  }
}
