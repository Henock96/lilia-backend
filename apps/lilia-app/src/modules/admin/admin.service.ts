import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRestaurantWithOwnerDto } from './dto/create-restaurant-with-owner.dto';
import { Prisma, Role, PaymentStatus, DeliveryStatus, VendorType } from '@prisma/client';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { DelivererMissionStatus } from './dto/get-deliverer-missions.dto';
import { UserCacheService } from '../auth/services/user-cache.service';
import { VendorsService } from '../vendors/vendors.service';
import { AdminVendorFilterDto } from './dto/admin-vendor-filter.dto';
import { FirebaseService } from '../firebase/firebase.service';
import { AdminDeliverersService } from './admin-deliverers.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminVendorsService } from './admin-vendors.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminUsersService } from './admin-users.service';
import { AdminReviewsService } from './admin-reviews.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private userCache: UserCacheService,
    private readonly vendorsService: VendorsService,
    private readonly firebaseService: FirebaseService,
    private readonly adminDeliverersService: AdminDeliverersService,
    private readonly adminPaymentsService: AdminPaymentsService,
    private readonly adminVendorsService: AdminVendorsService,
    private readonly adminClientsService: AdminClientsService,
    private readonly adminUsersService: AdminUsersService,
    private readonly adminReviewsService: AdminReviewsService,
  ) {}

  // ─── DASHBOARD ─────────────────────────────────────────────────────────────

  /**
   * Statistiques globales pour le tableau de bord admin.
   * Toutes les requêtes en parallèle — une seule attente.
   *
   * Retourne :
   *  - Nombre total d'utilisateurs par rôle
   *  - Chiffre d'affaires total et du jour
   *  - Nombre de commandes par statut
   *  - Restaurants actifs / inactifs
   *  - Commandes des 7 derniers jours (pour le graphe)
   */
  async getDashboardStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [
      usersByRole,
      totalRevenue,
      todayRevenue,
      ordersByStatus,
      restaurantStats,
      weeklyOrders,
      pendingOrders,
    ] = await Promise.all([
      // Utilisateurs par rôle
      this.prisma.user.groupBy({
        by: ['role'],
        _count: { role: true },
      }),

      // CA total — commandes payées uniquement
      this.prisma.order.aggregate({
        where: {
          status: { in: ['PAYER', 'EN_PREPARATION', 'PRET', 'LIVRER'] },
        },
        _sum: { total: true },
      }),

      // CA du jour
      this.prisma.order.aggregate({
        where: {
          status: { in: ['PAYER', 'EN_PREPARATION', 'PRET', 'LIVRER'] },
          createdAt: { gte: today },
        },
        _sum: { total: true },
      }),

      // Commandes par statut
      this.prisma.order.groupBy({
        by: ['status'],
        _count: { status: true },
      }),

      // Restaurants actifs vs inactifs
      this.prisma.restaurant.groupBy({
        by: ['isActive'],
        _count: { isActive: true },
      }),

      // Commandes des 7 derniers jours pour le graphe
      this.prisma.order.groupBy({
        by: ['createdAt'],
        where: { createdAt: { gte: sevenDaysAgo } },
        _count: { id: true },
        _sum: { total: true },
      }),

      // Commandes en attente — à surveiller
      this.prisma.order.count({ where: { status: 'EN_ATTENTE' } }),
    ]);

    return {
      users: {
        byRole: Object.fromEntries(
          usersByRole.map((u) => [u.role, u._count.role]),
        ),
        total: usersByRole.reduce((sum, u) => sum + u._count.role, 0),
      },
      revenue: {
        total: totalRevenue._sum.total ?? 0,
        today: todayRevenue._sum.total ?? 0,
      },
      orders: {
        byStatus: Object.fromEntries(
          ordersByStatus.map((o) => [o.status, o._count.status]),
        ),
        pendingCount: pendingOrders,
        weekly: weeklyOrders,
      },
      restaurants: {
        active: restaurantStats.find((r) => r.isActive)?._count.isActive ?? 0,
        inactive:
          restaurantStats.find((r) => !r.isActive)?._count.isActive ?? 0,
      },
    };
  }
  // ─── GESTION RESTAURANTS ───────────────────────────────────────────────────

  /**
   * Crée un restaurant avec son propriétaire en une seule transaction.
   * Si l'owner n'existe pas encore, on peut le créer aussi.
   */
  async createRestaurantWithOwner(dto: CreateRestaurantWithOwnerDto) {
    const {
      email,
      password,
      nom,
      phone,
      restaurantNom,
      restaurantAdresse,
      restaurantPhone,
      restaurantImageUrl,
      vendorType,
      acceptsPreorders,
      preorderLeadHours,
      maxOrdersPerDay,
      story,
      certifications,
      specialties,
      productionNote,
    } = dto;

    // Compat. : si pas de vendorType, on garde le flux historique (RESTAURANT
    // auto-approuvé). Les nouveaux types passent toujours par la validation
    // admin (adminApproved=false), même créés via cette route.
    const effectiveType = vendorType ?? VendorType.RESTAURANT;
    const isAutoApproved = effectiveType === VendorType.RESTAURANT;

    const profileFields: Prisma.VendorProfileCreateWithoutRestaurantInput = {};
    if (story !== undefined) profileFields.story = story;
    if (certifications !== undefined) profileFields.certifications = certifications;
    if (specialties !== undefined) profileFields.specialties = specialties;
    if (productionNote !== undefined) profileFields.productionNote = productionNote;
    const hasProfile = Object.keys(profileFields).length > 0;

    // LIL-118 : on crée le user Firebase Auth AVANT la transaction Prisma.
    // Avant : l'admin devait créer l'user dans la Console et coller l'UID — UX
    // catastrophique, password DTO ignoré. Maintenant l'admin remplit juste
    // email + password et on bootstrap tout côté Firebase.
    let firebaseUid: string;
    try {
      firebaseUid = await this.firebaseService.createUser({
        email,
        password,
        displayName: nom,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const message = (err as { message?: string }).message;
      if (code === 'auth/email-already-exists') {
        throw new BadRequestException(
          `Un compte Firebase existe déjà pour ${email}.`,
        );
      }
      if (code === 'auth/invalid-password' || code === 'auth/weak-password') {
        throw new BadRequestException(
          'Mot de passe invalide (min 6 caractères).',
        );
      }
      throw new BadRequestException(
        message ?? 'Échec de la création du compte Firebase.',
      );
    }

    // Si la transaction Prisma échoue, on supprime le user Firebase qu'on
    // vient de créer pour ne pas laisser de zombie côté Firebase Console.
    try {
      return await this.prisma.$transaction(async (tx) => {
        // L'user Firebase étant tout neuf, il ne devrait JAMAIS exister
        // déjà en DB. On garde quand même le findUnique par sécurité
        // (concurrent webhook /users/sync, par ex.).
        let owner = await tx.user.findUnique({
          where: { firebaseUid },
        });

        if (!owner) {
          owner = await tx.user.create({
            data: {
              firebaseUid,
              email,
              nom: nom || email.split('@')[0],
              phone: phone ?? '',
              role: 'RESTAURATEUR',
            },
          });
          this.logger.log(`Owner créé : ${owner.id}`);
        } else if (owner.role !== 'RESTAURATEUR' && owner.role !== 'ADMIN') {
          owner = await tx.user.update({
            where: { id: owner.id },
            data: { role: 'RESTAURATEUR' },
          });
        }

        // Vérifie qu'il n'a pas déjà un restaurant
        const existing = await tx.restaurant.findUnique({
          where: { ownerId: owner.id },
        });
        if (existing) {
          throw new BadRequestException(
            'Cet utilisateur possède déjà un restaurant.',
          );
        }

        const restaurant = await tx.restaurant.create({
          data: {
            nom: restaurantNom,
            adresse: restaurantAdresse,
            phone: restaurantPhone,
            imageUrl: restaurantImageUrl,
            vendorType: effectiveType,
            adminApproved: isAutoApproved,
            adminApprovedAt: isAutoApproved ? new Date() : null,
            acceptsPreorders: acceptsPreorders ?? false,
            preorderLeadHours,
            maxOrdersPerDay,
            owner: { connect: { id: owner.id } },
            ...(hasProfile && {
              vendorProfile: { create: profileFields },
            }),
          },
          include: {
            owner: { select: { id: true, email: true, role: true } },
            vendorProfile: true,
          },
        });

        this.logger.log(
          `Vendeur ${effectiveType} créé par admin : ${restaurant.id} (adminApproved=${isAutoApproved})`,
        );
        return {
          data: restaurant,
          message: isAutoApproved
            ? 'Restaurant et propriétaire créés avec succès'
            : `${effectiveType} créé — en attente de validation`,
        };
      });
    } catch (err) {
      // Rollback Firebase user : la transaction Prisma a échoué, on ne
      // laisse pas un compte Firebase orphelin sans entrée DB associée.
      // deleteUserSafe absorbe ses propres erreurs.
      await this.firebaseService.deleteUserSafe(firebaseUid);
      throw err;
    }
  }

  async getAllRestaurants() {
    const restaurants = await this.prisma.restaurant.findMany({
      include: {
        owner: { select: { id: true, email: true, nom: true, phone: true } },
        specialties: true,
        _count: { select: { orders: true, products: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: restaurants, total: restaurants.length };
  }

  async toggleRestaurantActive(restaurantId: string, isActive: boolean) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });
    if (!restaurant) throw new NotFoundException('Restaurant non trouvé');

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isActive, isOpen: isActive ? restaurant.isOpen : false },
    });

    this.logger.warn(
      `Restaurant ${restaurantId} ${isActive ? 'activé' : 'désactivé'} par admin`,
    );
    return {
      data: updated,
      message: isActive ? 'Restaurant activé' : 'Restaurant désactivé',
    };
  }
  // ─── GESTION UTILISATEURS ──────────────────────────────────────────────────

  /**
   * Récupère tous les clients de la plateforme (ADMIN uniquement)
   */
  async getAllClients(page = 1, limit = 20, search?: string) {
    return this.adminClientsService.getAllClients(page, limit, search);
  }

  async getAllUsers(page = 1, limit = 20, role?: Role) {
    return this.adminUsersService.getAllUsers(page, limit, role);
  }
  /**
   * Change le rôle d'un utilisateur.
   * Protège contre la rétrogradation d'un ADMIN.
   */
  async updateUserRole(userId: string, dto: UpdateUserRoleDto) {
    return this.adminUsersService.updateUserRole(userId, dto);
  }

  /**
   * Bannit un utilisateur : désactive son compte et révoque ses tokens.
   * À coupler avec FirebaseService.revokeUserTokens() dans le controller.
   */
  async banUser(userId: string, reason?: string) {
    return this.adminUsersService.banUser(userId, reason);
  }

  // ─── GESTION LIVREURS ──────────────────────────────────────────────────────

  async getAllDeliverers(page = 1, limit = 20) {
    return this.adminDeliverersService.getAllDeliverers(page, limit);
  }

  /**
   * Statistiques agrégées d'un livreur :
   * - totalDeliveries / deliveredCount / failedCount / inProgressCount
   *   (inProgress = ASSIGNER ou EN_TRANSIT)
   * - successRate = deliveredCount / (deliveredCount + failedCount) * 100
   *   (0 si dénominateur nul ; arrondi à 2 décimales)
   * - totalRevenueXAF = somme Order.total des deliveries au statut LIVRER
   * - avgDeliveryMinutes = moyenne (deliveredAt - pickedUpAt) en minutes
   *   sur les deliveries LIVRER qui ont un pickedUpAt non nul.
   *   `pickedUpAt` est utilisé comme « acceptedAt » (le timestamp est posé
   *   lors du passage ASSIGNER → EN_TRANSIT dans DeliveriesService.markPickedUp).
   *   Renvoie null s'il n'y a aucune ligne mesurable.
   * - last30dDeliveries = nombre de deliveries créées sur les 30 derniers jours
   * - lastDeliveryAt = deliveredAt de la dernière livraison LIVRER
   *
   * 404 si l'utilisateur n'existe pas ou n'a pas le rôle LIVREUR.
   */
  async getDelivererStats(delivererId: string) {
    return this.adminDeliverersService.getDelivererStats(delivererId);
  }

  /**
   * Historique paginé des missions d'un livreur, sous forme de
   * DeliveryMissionSummary `{ id, orderId, status, restaurantName,
   * clientName, totalXAF, acceptedAt?, deliveredAt?, createdAt }`.
   *
   * `acceptedAt` est mappé sur `Delivery.pickedUpAt` (le timestamp posé
   * quand le livreur passe la mission de ASSIGNER → EN_TRANSIT).
   *
   * Filtres : status (EN_ATTENTE|EN_TRANSIT|LIVRER|ECHEC), page, limit.
   * 404 si l'utilisateur n'existe pas ou n'a pas le rôle LIVREUR.
   */
  async getDelivererMissions(
    delivererId: string,
    status?: DelivererMissionStatus,
    page = 1,
    limit = 20,
  ) {
    return this.adminDeliverersService.getDelivererMissions(delivererId, status, page, limit);
  }

  // ─── SUPERVISION COMMANDES ─────────────────────────────────────────────────

  /**
   * Toutes les commandes actives (pas encore livrées ni annulées).
   * Utile pour la supervision en temps réel depuis le dashboard admin.
   */
  async getActiveOrders() {
    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: ['EN_ATTENTE', 'PAYER', 'EN_PREPARATION', 'PRET'] },
      },
      include: {
        restaurant: { select: { nom: true } },
        user: { select: { nom: true, phone: true } },
        delivery: { select: { status: true, delivererId: true } },
      },
      orderBy: { createdAt: 'asc' }, // les plus anciennes en premier
    });

    return { data: orders, count: orders.length };
  }

  // ─── FIDÉLITÉ & PARRAINAGE ─────────────────────────────────────────────────

  /**
   * Solde de points + historique paginé des transactions de fidélité d'un client.
   * Réservé ADMIN (route protégée au niveau controller).
   */
  async getClientLoyalty(clientId: string, page = 1, limit = 20) {
    return this.adminClientsService.getClientLoyalty(clientId, page, limit);
  }

  /**
   * Statistiques de parrainage d'un client : son code, le code de son parrain,
   * le nombre de filleuls, ceux convertis (1ʳᵉ commande livrée → referralRewarded),
   * et le total de points gagnés via le parrainage.
   */
  async getClientReferral(clientId: string) {
    return this.adminClientsService.getClientReferral(clientId);
  }

  /**
   * Commandes paginées avec filtres — vue complète admin.
   */
  async getAllOrders(page = 1, limit = 20, status?: string) {
    const where = status ? { status: status as any } : {};

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          restaurant: { select: { nom: true } },
          user: { select: { nom: true, email: true } },
          items: { include: { product: { select: { nom: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data: orders, total, page, limit };
  }

  /**
   * Liste paginée des paiements pour la supervision admin.
   *
   * `status` :
   *   - omis ou chaîne vide → tous statuts confondus (vue "Tous" admin)
   *   - 'PENDING' / 'SUCCESS' / 'FAILED' / 'CANCELLED' → filtre par valeur
   *
   * Inclut `order.paymentMethod` (MTN_MOMO | AIRTEL_MONEY) — indispensable
   * pour distinguer MTN vs Airtel quand `Payment.provider == 'MANUAL'`.
   */
  async listPayments(page = 1, limit = 20, status?: string) {
    return this.adminPaymentsService.listPayments(page, limit, status);
  }

  /**
   * KPI agrégés pour la carte stats `/admin/paiements` :
   *   - `pending` : nombre + montant total des paiements à confirmer
   *   - `monthSuccess` : SUCCESS depuis le 1er du mois (à fuseau UTC pour
   *     simplifier — Brazzaville = UTC+1, écart négligeable sur les bornes)
   *   - `last7DaysSuccess` : SUCCESS sur les 7 derniers jours roulants
   */
  async getPaymentsStats() {
    return this.adminPaymentsService.getPaymentsStats();
  }

  // ─── MODÉRATION AVIS ───────────────────────────────────────────────────────

  async getAllReviews(page = 1, limit = 20) {
    return this.adminReviewsService.getAllReviews(page, limit);
  }

  async deleteReview(reviewId: string) {
    return this.adminReviewsService.deleteReview(reviewId);
  }

  // ─── VENDORS (marketplace multi-vendeurs) ──────────────────────────────────

  /**
   * Liste paginée de tous les vendeurs (Restaurant) avec filtres admin.
   * Contrairement à `GET /vendors` (marketplace public) qui filtre sur
   * adminApproved=true + isActive=true, ici l'admin voit TOUT.
   */
  async getAllVendors(dto: AdminVendorFilterDto) {
    return this.adminVendorsService.getAllVendors(dto);
  }

  /**
   * Vendeurs en attente de validation (adminApproved=false).
   * Raccourci pratique pour le badge "À valider" sur l'admin dashboard.
   */
  async getPendingVendors() {
    return this.adminVendorsService.getPendingVendors();
  }

  /**
   * Approuve un vendeur — délègue à VendorsService pour garder la logique
   * (event vendor.approved, audit trail) en un seul endroit.
   */
  async approveVendor(restaurantId: string, adminUserId: string) {
    return this.adminVendorsService.approveVendor(restaurantId, adminUserId);
  }

  /**
   * Suspend un vendeur : désactive (isActive=false) + ferme (isOpen=false).
   * Réversible via toggleRestaurantActive(id, true).
   *
   * On NE touche PAS à adminApproved — un vendeur peut être suspendu
   * temporairement sans repasser par toute la validation initiale.
   */
  async suspendVendor(restaurantId: string, reason: string, adminUserId: string) {
    return this.adminVendorsService.suspendVendor(restaurantId, reason, adminUserId);
  }

  /**
   * Réactive un vendeur suspendu : isActive=true. On NE rouvre PAS
   * automatiquement (isOpen) — c'est au restaurateur de rouvrir selon ses
   * horaires. Inverse réversible de `suspendVendor`.
   */
  async activateVendor(restaurantId: string, adminUserId: string) {
    return this.adminVendorsService.activateVendor(restaurantId, adminUserId);
  }
}
