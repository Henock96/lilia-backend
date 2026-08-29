import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
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

    // Minimisation des données (fix L12) : le vendeur reçoit ce qu'il lui faut
    // pour préparer et livrer — nom, téléphone, photo. Pas l'e-mail, qui n'a
    // aucun usage opérationnel et alimente les exports sauvages.
    const baseInclude = {
      items: {
        include: { product: { select: { nom: true, imageUrl: true } } },
      },
      restaurant: { select: { nom: true } },
    };

    const vendorInclude = {
      ...baseInclude,
      user: {
        select: { id: true, nom: true, phone: true, imageUrl: true },
      },
    };

    const adminInclude = {
      ...baseInclude,
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
      // PERFORMANCE (fix P1) : `order.count()` sans `where` force un scan
      // séquentiel complet de la table à CHAQUE page. On borne sur les
      // commandes non supprimées, ce qui laisse PostgreSQL utiliser un index
      // et évite d'annoncer un total incluant les soft-deletes.
      const adminWhere = { deleteCommande: false };
      const [orders, total] = await Promise.all([
        this.prisma.order.findMany({
          where: adminWhere,
          include: adminInclude,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.order.count({ where: adminWhere }),
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
      throw new NotFoundException(
        'Restaurant non trouvé pour cet utilisateur.',
      );
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { restaurantId: restaurant.id },
        include: vendorInclude,
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

  /**
   * Nombre de commandes payées que le vendeur n'a pas encore prises en charge
   * (fix H7). Alimente le badge de l'app vendeur : c'est le filet qui ne
   * dépend d'aucun push.
   */
  async countUnhandledRestaurantOrders(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const where =
      user.role === 'ADMIN'
        ? { status: { in: [OrderStatus.EN_ATTENTE, OrderStatus.PAYER] } }
        : {
            restaurant: { ownerId: user.id },
            status: { in: [OrderStatus.EN_ATTENTE, OrderStatus.PAYER] },
          };

    const [paid, awaitingPayment, oldest] = await Promise.all([
      this.prisma.order.count({
        where: { ...where, status: OrderStatus.PAYER },
      }),
      this.prisma.order.count({
        where: { ...where, status: OrderStatus.EN_ATTENTE },
      }),
      this.prisma.order.findFirst({
        where: { ...where, status: OrderStatus.PAYER },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    return {
      data: {
        // Ce qui doit déclencher une action immédiate : payé, pas encore ouvert.
        unhandledPaid: paid,
        awaitingPayment,
        oldestPendingAt: oldest?.createdAt ?? null,
      },
    };
  }

  async findOrdersByUserId(
    userId: string,
    caller?: { role: string },
    page = 1,
    limit = 20,
  ) {
    // Defense-in-depth : méthode admin uniquement. Le controller la garde déjà
    // via @Roles('ADMIN') mais on revérifie ici pour ne pas dépendre d'une seule
    // couche (une future route oubliant le guard ne fuiterait pas les commandes).
    if (caller && caller.role !== 'ADMIN') {
      throw new ForbiddenException('Accès réservé aux administrateurs.');
    }
    // PERFORMANCE (fix P1) : la méthode ramenait TOUTES les commandes du
    // client, items et produits inclus. Sur un client fidèle, c'est une
    // réponse qui grossit indéfiniment.
    const where = { userId, deleteCommande: false };
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          restaurant: { select: { nom: true, imageUrl: true, adresse: true } },
          items: {
            include: { product: { select: { nom: true, imageUrl: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders,
      meta: this.pagination.getPaginationMeta(page, limit, total),
    };
  }
}
