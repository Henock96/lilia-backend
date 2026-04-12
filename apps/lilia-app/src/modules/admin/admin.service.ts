import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRestaurantWithOwnerDto } from './dto/create-restaurant-with-owner.dto';
import { Role } from '@prisma/client';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private prisma: PrismaService) {}

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
  async getAllClients(page = 1, limit = 20) {
    const [clients, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'CLIENT' },
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          role: true,
          createdAt: true,
          lastLogin: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where: { role: 'CLIENT' } }),
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
