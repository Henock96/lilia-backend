import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';

/**
 * Lectures de commandes (queries) extraites de `OrdersService` (LIL-134).
 *
 * Responsabilité unique : récupérer et paginer des commandes avec contrôle de
 * propriété/rôle. Aucune mutation, aucun event. `OrdersService` délègue ici pour
 * rester une façade mince côté écriture/cycle de vie.
 */
@Injectable()
export class OrderQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pagination: PaginationService,
  ) {}

  async findOrderById(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        restaurant: { select: { nom: true, imageUrl: true, adresse: true } },
        items: {
          include: {
            product: { select: { nom: true, imageUrl: true } },
          },
        },
        delivery: true,
      },
    });

    if (!order) throw new NotFoundException('Commande introuvable.');
    if (order.userId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Accès refusé.');
    }

    return order;
  }

  /**
   * Récupère les commandes d'un client spécifique.
   */
  async findOrdersClient(page = 1, limit = 10, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        skip: (page - 1) * limit,
        take: limit,
        where: { userId: user.id, deleteCommande: false },
        include: {
          restaurant: { select: { nom: true, imageUrl: true, adresse: true } },
          items: {
            include: {
              product: {
                select: {
                  nom: true,
                  description: true,
                  imageUrl: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.order.count({
        where: { userId: user.id, deleteCommande: false },
      }),
    ]);
    return {
      data: orders,
      meta: this.pagination.getPaginationMeta(page, limit, total),
    };
  }

  /**
   * Récupère les commandes d'un restaurant spécifique.
   * ADMIN voit toutes les commandes de tous les restaurants.
   */
  async findRestaurantOrders(firebaseUid: string, page = 1, limit = 20) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const include = {
      items: {
        include: { product: { select: { nom: true, imageUrl: true } } },
      },
      restaurant: { select: { nom: true } },
      user: {
        select: {
          id: true,
          nom: true,
          phone: true,
          email: true,
          imageUrl: true,
        },
      },
    };

    if (user.role === 'ADMIN') {
      const [orders, total] = await Promise.all([
        this.prisma.order.findMany({
          include,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.order.count(),
      ]);
      return {
        data: orders,
        meta: this.pagination.getPaginationMeta(page, limit, total),
      };
    }

    // RESTAURATEUR : ses commandes uniquement
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé pour cet utilisateur.');
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { restaurantId: restaurant.id },
        include,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where: { restaurantId: restaurant.id } }),
    ]);

    return {
      data: orders,
      meta: this.pagination.getPaginationMeta(page, limit, total),
    };
  }

  async findOrdersByUserId(userId: string, caller?: { role: string }) {
    // Defense-in-depth : méthode admin uniquement. Le controller la garde déjà
    // via @Roles('ADMIN') mais on revérifie ici pour ne pas dépendre d'une seule
    // couche (une future route oubliant le guard ne fuiterait pas les commandes).
    if (caller && caller.role !== 'ADMIN') {
      throw new ForbiddenException('Accès réservé aux administrateurs.');
    }
    const orders = await this.prisma.order.findMany({
      where: { userId, deleteCommande: false },
      include: {
        restaurant: { select: { nom: true, imageUrl: true, adresse: true } },
        items: {
          include: { product: { select: { nom: true, imageUrl: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { data: orders };
  }
}
