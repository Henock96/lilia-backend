import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRestaurantWithOwnerDto } from './dto/create-restaurant-with-owner.dto';
import { Prisma, Role, PaymentStatus, DeliveryStatus } from '@prisma/client';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { DelivererMissionStatus } from './dto/get-deliverer-missions.dto';
import { UserCacheService } from '../auth/services/user-cache.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private userCache: UserCacheService,
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
      ownerFirebaseUid,
      restaurantNom,
      restaurantAdresse,
      restaurantPhone,
    } = dto;

    return this.prisma.$transaction(async (tx) => {
      // Cherche ou crée l'owner
      let owner = await tx.user.findUnique({
        where: { firebaseUid: ownerFirebaseUid },
      });

      if (!owner) {
        owner = await tx.user.create({
          data: {
            firebaseUid: ownerFirebaseUid,
            email: email,
            nom: email.split('@')[0],
            phone: '',
            role: 'RESTAURATEUR',
          },
        });
        this.logger.log(`Owner créé : ${owner.id}`);
      } else if (owner.role !== 'RESTAURATEUR' && owner.role !== 'ADMIN') {
        // Upgrade le rôle si nécessaire
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
          owner: { connect: { id: owner.id } },
        },
        include: { owner: { select: { id: true, email: true, role: true } } },
      });

      this.logger.log(`Restaurant créé par admin : ${restaurant.id}`);
      return {
        data: restaurant,
        message: 'Restaurant et propriétaire créés avec succès',
      };
    });
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
    const where: Prisma.UserWhereInput = {
      role: 'CLIENT',
      ...(search && {
        OR: [
          { nom: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [clients, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          role: true,
          createdAt: true,
          lastLogin: true,
          loyaltyPoints: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: clients, total, page, limit };
  }

  async getAllUsers(page = 1, limit = 20, role?: Role) {
    const where = role ? { role } : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          role: true,
          createdAt: true,
          lastLogin: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: users, total, page, limit };
  }
  /**
   * Change le rôle d'un utilisateur.
   * Protège contre la rétrogradation d'un ADMIN.
   */
  async updateUserRole(userId: string, dto: UpdateUserRoleDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    if (user.role === 'ADMIN' && dto.role !== 'ADMIN') {
      throw new BadRequestException(
        "Impossible de rétrograder un compte ADMIN via l'API.",
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
      select: { id: true, email: true, nom: true, role: true },
    });

    // Invalider le cache : le role est lu par RolesGuard à chaque requête.
    await this.userCache.invalidate(user.firebaseUid);

    this.logger.warn(`Rôle modifié : user ${userId} → ${dto.role}`);
    return { data: updated, message: `Rôle mis à jour : ${dto.role}` };
  }

  /**
   * Bannit un utilisateur : désactive son compte et révoque ses tokens.
   * À coupler avec FirebaseService.revokeUserTokens() dans le controller.
   */
  async banUser(userId: string, reason?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    if (user.role === 'ADMIN')
      throw new BadRequestException('Impossible de bannir un ADMIN.');

    // On stocke la raison dans les métadonnées — à adapter si tu ajoutes un champ bannedAt
    this.logger.warn(
      `User ${userId} banni — raison : ${reason ?? 'non précisée'}`,
    );

    // Invalider le cache : la prochaine requête forcera un refetch et verra
    // statusUser=BANNED (à venir) ou refusera l'accès.
    await this.userCache.invalidate(user.firebaseUid);

    // Retourne le firebaseUid pour que le controller révoque les tokens Firebase
    return { firebaseUid: user.firebaseUid, userId: user.id };
  }

  // ─── GESTION LIVREURS ──────────────────────────────────────────────────────

  async getAllDeliverers(page = 1, limit = 20) {
    const [deliverers, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'LIVREUR' },
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          createdAt: true,
          deliveries: {
            select: { id: true, status: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 5, // 5 dernières livraisons
          },
          _count: { select: { deliveries: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where: { role: 'LIVREUR' } }),
    ]);

    return { data: deliverers, total, page, limit };
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
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: { id: true, role: true },
    });
    if (!deliverer || deliverer.role !== 'LIVREUR') {
      throw new NotFoundException('Livreur introuvable');
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [grouped, deliveredRows, last30dDeliveries, lastDelivery] =
      await Promise.all([
        this.prisma.delivery.groupBy({
          by: ['status'],
          where: { delivererId },
          _count: { _all: true },
        }),
        // Toutes les deliveries LIVRER pour calculer revenue et avg duration
        this.prisma.delivery.findMany({
          where: { delivererId, status: DeliveryStatus.LIVRER },
          select: {
            pickedUpAt: true,
            deliveredAt: true,
            order: { select: { total: true } },
          },
        }),
        this.prisma.delivery.count({
          where: { delivererId, createdAt: { gte: thirtyDaysAgo } },
        }),
        this.prisma.delivery.findFirst({
          where: {
            delivererId,
            status: DeliveryStatus.LIVRER,
            deliveredAt: { not: null },
          },
          orderBy: { deliveredAt: 'desc' },
          select: { deliveredAt: true },
        }),
      ]);

    const countOf = (status: DeliveryStatus) =>
      grouped.find((g) => g.status === status)?._count?._all ?? 0;

    const deliveredCount = countOf(DeliveryStatus.LIVRER);
    const failedCount = countOf(DeliveryStatus.ECHEC);
    const inProgressCount =
      countOf(DeliveryStatus.ASSIGNER) + countOf(DeliveryStatus.EN_TRANSIT);
    const totalDeliveries = grouped.reduce(
      (sum, g) => sum + (g._count?._all ?? 0),
      0,
    );

    const finished = deliveredCount + failedCount;
    const successRate =
      finished === 0
        ? 0
        : Math.round((deliveredCount / finished) * 100 * 100) / 100;

    const totalRevenueXAF = deliveredRows.reduce(
      (sum, d) => sum + (d.order?.total ?? 0),
      0,
    );

    const durations = deliveredRows
      .filter((d) => d.pickedUpAt && d.deliveredAt)
      .map(
        (d) =>
          (d.deliveredAt!.getTime() - d.pickedUpAt!.getTime()) / 60000,
      );
    const avgDeliveryMinutes =
      durations.length === 0
        ? null
        : Math.round(
            (durations.reduce((s, x) => s + x, 0) / durations.length) * 100,
          ) / 100;

    return {
      data: {
        totalDeliveries,
        deliveredCount,
        failedCount,
        inProgressCount,
        successRate,
        totalRevenueXAF,
        avgDeliveryMinutes,
        last30dDeliveries,
        lastDeliveryAt: lastDelivery?.deliveredAt ?? null,
      },
    };
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
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: { id: true, role: true },
    });
    if (!deliverer || deliverer.role !== 'LIVREUR') {
      throw new NotFoundException('Livreur introuvable');
    }

    const where: Prisma.DeliveryWhereInput = {
      delivererId,
      ...(status ? { status } : {}),
    };

    const [deliveries, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          orderId: true,
          status: true,
          createdAt: true,
          pickedUpAt: true,
          deliveredAt: true,
          order: {
            select: {
              total: true,
              restaurant: { select: { nom: true } },
              user: { select: { nom: true } },
            },
          },
        },
      }),
      this.prisma.delivery.count({ where }),
    ]);

    const data = deliveries.map((d) => ({
      id: d.id,
      orderId: d.orderId,
      status: d.status,
      restaurantName: d.order?.restaurant?.nom ?? null,
      clientName: d.order?.user?.nom ?? null,
      totalXAF: d.order?.total ?? 0,
      acceptedAt: d.pickedUpAt ?? null,
      deliveredAt: d.deliveredAt ?? null,
      createdAt: d.createdAt,
    }));

    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

    return {
      data,
      meta: { total, page, limit, totalPages },
    };
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
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, loyaltyPoints: true },
    });
    if (!user) throw new NotFoundException('Client introuvable');

    const [transactions, total] = await Promise.all([
      this.prisma.loyaltyTransaction.findMany({
        where: { userId: clientId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.loyaltyTransaction.count({ where: { userId: clientId } }),
    ]);

    return {
      data: { balance: user.loyaltyPoints, transactions },
      total,
      page,
      limit,
    };
  }

  /**
   * Statistiques de parrainage d'un client : son code, le code de son parrain,
   * le nombre de filleuls, ceux convertis (1ʳᵉ commande livrée → referralRewarded),
   * et le total de points gagnés via le parrainage.
   */
  async getClientReferral(clientId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, referralCode: true, referredByCode: true },
    });
    if (!user) throw new NotFoundException('Client introuvable');

    const [totalReferrals, convertedReferrals, bonusAgg] = await Promise.all([
      user.referralCode
        ? this.prisma.user.count({ where: { referredByCode: user.referralCode } })
        : Promise.resolve(0),
      user.referralCode
        ? this.prisma.user.count({
            where: { referredByCode: user.referralCode, referralRewarded: true },
          })
        : Promise.resolve(0),
      this.prisma.loyaltyTransaction.aggregate({
        where: {
          userId: clientId,
          reason: { contains: 'parrainage', mode: 'insensitive' },
        },
        _sum: { points: true },
      }),
    ]);

    return {
      data: {
        referralCode: user.referralCode,
        referredByCode: user.referredByCode,
        totalReferrals,
        convertedReferrals,
        referralBonusEarned: bonusAgg._sum.points ?? 0,
      },
    };
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
    const normalized = status?.trim() ? status.trim() : undefined;
    if (normalized !== undefined) {
      const validStatuses = Object.values(PaymentStatus) as string[];
      if (!validStatuses.includes(normalized)) {
        throw new BadRequestException(
          `Statut de paiement invalide : ${normalized}. Valeurs acceptées : ${validStatuses.join(', ')}`,
        );
      }
    }
    const where = normalized
      ? { status: normalized as PaymentStatus }
      : {};

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          order: {
            select: {
              id: true,
              total: true,
              status: true,
              paymentMethod: true,
              user: { select: { id: true, nom: true, phone: true } },
            },
          },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { data: payments, total, page, limit };
  }

  /**
   * KPI agrégés pour la carte stats `/admin/paiements` :
   *   - `pending` : nombre + montant total des paiements à confirmer
   *   - `monthSuccess` : SUCCESS depuis le 1er du mois (à fuseau UTC pour
   *     simplifier — Brazzaville = UTC+1, écart négligeable sur les bornes)
   *   - `last7DaysSuccess` : SUCCESS sur les 7 derniers jours roulants
   */
  async getPaymentsStats() {
    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [pending, monthSuccess, last7DaysSuccess] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { status: PaymentStatus.PENDING },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          status: PaymentStatus.SUCCESS,
          createdAt: { gte: startOfMonth },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          status: PaymentStatus.SUCCESS,
          createdAt: { gte: sevenDaysAgo },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    return {
      pending: {
        count: pending._count._all,
        totalXaf: pending._sum.amount ?? 0,
      },
      monthSuccess: {
        count: monthSuccess._count._all,
        totalXaf: monthSuccess._sum.amount ?? 0,
      },
      last7DaysSuccess: {
        count: last7DaysSuccess._count._all,
        totalXaf: last7DaysSuccess._sum.amount ?? 0,
      },
    };
  }

  // ─── MODÉRATION AVIS ───────────────────────────────────────────────────────

  async getAllReviews(page = 1, limit = 20) {
    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        include: {
          user: { select: { nom: true, email: true } },
          restaurant: { select: { nom: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count(),
    ]);

    return { data: reviews, total, page, limit };
  }

  async deleteReview(reviewId: string) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
    });
    if (!review) throw new NotFoundException('Avis non trouvé');

    await this.prisma.review.delete({ where: { id: reviewId } });
    this.logger.warn(`Avis ${reviewId} supprimé par admin`);

    return { message: 'Avis supprimé' };
  }
}
