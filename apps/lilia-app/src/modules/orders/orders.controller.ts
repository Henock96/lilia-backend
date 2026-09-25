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
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { OrderReceiptService } from './order-receipt.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { AcceptOrderDto, RejectOrderDto } from './dto/order-acceptance.dto';
import { PickupHandoverDto } from './dto/pickup-handover.dto';
import { StuckOrdersQueryDto } from './dto/stuck-orders-query.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DecodedIdToken } from 'firebase-admin/auth';
import { User } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { MaintenanceGuard } from '../platform-settings/guards/maintenance.guard';
import { MinAppVersionGuard } from '../platform-settings/guards/min-app-version.guard';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

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
  // Le throttle global (100/min) est trop large pour un endpoint qui crée des
  // commandes et décrémente du stock. L'idempotence couvre le double-tap, pas
  // un script qui boucle. Limites alignées sur /promo/validate et /reviews.
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 10, ttl: 60000 } })
  @Post('checkout')
  // Maintenance d'abord : pendant une fenêtre de maintenance, « mettez à jour »
  // serait un mauvais conseil — la mise à jour ne débloquerait rien.
  @UseGuards(MaintenanceGuard, MinAppVersionGuard)
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
    @Query() query: PaginationQueryDto,
  ) {
    return this.ordersService.findOrdersClient(
      query.page,
      query.limit,
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
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      'EN_ATTENTE | PAYER | EN_PREPARATION | PRET | EN_ROUTE | LIVRER | ' +
      'ANNULER. Vide ou absent = tous statuts. Le filtre est appliqué en SQL : ' +
      'filtrer une page déjà tronquée ne rendrait que les commandes de cette page.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Recherche libre : identifiant de commande (complet ou tronqué), nom du ' +
      'client, téléphone, nom du vendeur. Pour un RESTAURATEUR, elle reste ' +
      'bornée à sa propre boutique.',
  })
  getRestaurantOrders(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query() query: PaginationQueryDto,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.ordersService.findRestaurantOrders(
      fbUser.uid,
      query.page,
      query.limit,
      status,
      search,
    );
  }
  /**
   * Commandes bloquées — la source de l'alerte du tableau de bord.
   *
   * L'alerte filtrait auparavant les vingt commandes reçues : une commande
   * bloquée depuis trois heures en sortait dès que vingt plus récentes
   * arrivaient. Elle s'éteignait donc précisément quand le problème
   * s'aggravait (audit du 09/09/2026, D-4).
   *
   * ⚠️ Déclarée **avant** `@Get(':id')`, comme ses voisines : sinon
   * « restaurant » serait lu comme un identifiant de commande.
   */
  @Get('restaurant/stuck')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({
    summary: 'Commandes payées que personne n’a fait avancer',
    description:
      'Compte les commandes `PAYER`, `EN_PREPARATION` et `PRET` créées il y a ' +
      'plus de `minutes`. `EN_ATTENTE` est exclu (non payée, fermée seule par ' +
      'le cron d’expiration) et `EN_ROUTE` aussi (quelqu’un la porte). Les ' +
      'précommandes dont l’échéance n’est pas venue ne sont jamais comptées.',
  })
  @ApiQuery({
    name: 'minutes',
    required: false,
    description: 'Seuil en minutes (1 à 1440). Défaut : 30.',
  })
  getStuckOrders(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query() query: StuckOrdersQueryDto,
  ) {
    return this.ordersService.countStuckOrders(fbUser.uid, query.minutes);
  }

  /**
   * Badge « commandes non ouvertes » (fix H7).
   *
   * Correction minimale au risque n°1 du métier : une commande payée que le
   * vendeur ne voit jamais parce que le push FCM s'est perdu. L'app vendeur
   * poll cette route toutes les 30 s et affiche un compteur — la notification
   * push ne sert plus qu'à la latence, plus à la correction.
   */
  @Get('restaurant/pending-count')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({
    summary: 'Nombre de commandes reçues non encore prises en charge',
  })
  getPendingOrdersCount(@FirebaseUser() fbUser: DecodedIdToken) {
    return this.ordersService.countUnhandledRestaurantOrders(fbUser.uid);
  }

  /**
   * Commandes d'un utilisateur spécifique — ADMIN uniquement.
   * Route déplacée depuis UserController où elle n'avait pas sa place.
   */
  @Get('user/:userId')
  @Roles('ADMIN')
  @ApiOperation({ summary: "Commandes d'un utilisateur (admin)" })
  @ApiParam({ name: 'userId', description: "ID Prisma de l'utilisateur" })
  getUserOrders(
    @Param('userId') userId: string,
    @CurrentUser() caller: User,
    @Query() query: PaginationQueryDto,
  ) {
    // findOrdersClient attend un firebaseUid — on ajoute une méthode par ID Prisma
    return this.ordersService.findOrdersByUserId(
      userId,
      caller,
      query.page,
      query.limit,
    );
  }

  /**
   * Détail d'une commande — accessible par son propriétaire ou un admin.
   */
  @Get(':id')
  @ApiOperation({ summary: "Détail d'une commande" })
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
   * Retrait au comptoir : « J'ai récupéré ma commande » (F3-07).
   *
   * Action du CLIENT propriétaire seul — ni le vendeur, ni l'admin ne peuvent
   * confirmer à sa place (la clôture admin est `PICKUP_ADMIN_OVERRIDE`, par la
   * route de statut). Idempotente : rejouée, elle rend la commande sans rien
   * réécrire. Rend la commande à jour.
   */
  @Post(':id/pickup/confirm')
  @Roles('CLIENT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmer le retrait d’une commande (client)' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({
    status: 200,
    description: 'Retrait confirmé (ou déjà prouvé)',
  })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiResponse({
    status: 409,
    description: 'Livraison, commande pas prête, ou close',
  })
  confirmPickup(
    @Param('id') id: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.ordersService.confirmPickup(id, fbUser.uid);
  }

  /**
   * Retrait au comptoir : le vendeur saisit le code montré par le client
   * (F3-07, D-P5). Sans code, la remise reste possible par la route de statut
   * (`HAND_OVER`), mais elle n'ouvre pas le versement automatique.
   */
  @Post(':id/pickup/handover')
  @Roles('RESTAURATEUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remettre un retrait avec le code du client (vendeur)',
  })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({ status: 200, description: 'Commande remise' })
  @ApiResponse({ status: 400, description: 'Code incorrect' })
  @ApiResponse({ status: 403, description: 'Hors restaurant, ou code bloqué' })
  @ApiResponse({
    status: 409,
    description: 'Pas un retrait, pas prête, ou sans code',
  })
  async handOverPickup(
    @Param('id') id: string,
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body() dto: PickupHandoverDto,
  ) {
    await this.ordersService.handOverPickupWithCode(id, fbUser.uid, dto.code);
    return { handedOver: true };
  }

  /**
   * Accepter une commande payée (Phase 3, F3-01).
   *
   * Seul chemin vers `ACCEPTEE` : le temps de préparation annoncé au client
   * est obligatoire. La propriété (vendeur de CETTE commande) est vérifiée par
   * le service.
   */
  @Post(':id/accept')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accepter une commande payée (vendeur / admin)' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({ status: 200, description: 'Commande acceptée' })
  @ApiResponse({
    status: 400,
    description: 'Commande non acceptable dans son état',
  })
  @ApiResponse({ status: 403, description: 'Commande hors restaurant' })
  @ApiResponse({ status: 409, description: 'Statut changé entre-temps' })
  acceptOrder(
    @Param('id') id: string,
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body() dto: AcceptOrderDto,
  ) {
    return this.ordersService.acceptOrder(id, fbUser.uid, dto.prepMinutes);
  }

  /**
   * Refuser une commande payée ou acceptée (Phase 3, F3-01).
   *
   * Motif obligatoire en liste fermée. Le client est remboursé : la dette est
   * écrite dans la même transaction que l'annulation.
   */
  @Post(':id/reject')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refuser une commande (vendeur / admin)' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiResponse({
    status: 200,
    description: 'Commande refusée, remboursement ouvert',
  })
  @ApiResponse({
    status: 403,
    description: 'Commande hors restaurant, ou déjà reversée',
  })
  rejectOrder(
    @Param('id') id: string,
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body() dto: RejectOrderDto,
  ) {
    return this.ordersService.rejectOrder(id, fbUser.uid, {
      reason: dto.reason,
      note: dto.note,
    });
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
