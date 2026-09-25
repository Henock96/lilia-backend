import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import {
  parseOrderStatusFilter,
  toOrderStatusCounts,
} from './order-status-filter';
import { buildOrderSearchWhere } from './order-search';

// Définition d'une commande « bloquée » — source unique, classement testé.
import { STUCK_ORDER_STATUSES } from './order-status-groups';
import {
  OrderAction,
  readActionContext,
  withAllowedActions,
} from './order-allowed-actions';
import { ORDER_ITEM_OPTIONS_ARGS } from '../modifiers/order-item-options';

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
            options: ORDER_ITEM_OPTIONS_ARGS,
          },
        },
        delivery: true,
      },
    });

    if (!order) throw new NotFoundException('Commande introuvable.');
    if (order.userId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Accès refusé.');
    }

    const [withActions] = await this.withAllowedActions([order], user.role);
    if (user.role === 'ADMIN') return withActions;
    if (order.isDelivery) return withoutPayoutSchedule(withActions);

    // F3-07 / D-P5 — le code de retrait n'est lu que pour le CLIENT
    // propriétaire, tant que sa commande attend au comptoir (I-18). L'admin
    // passe par la branche ci-dessus : il arbitre, il ne dicte pas le code.
    const pickupCode =
      order.status === 'PRET'
        ? ((
            await this.prisma.pickupHandover.findUnique({
              where: { orderId: order.id },
              select: { code: true },
            })
          )?.code ?? null)
        : null;
    return { ...withoutPayoutSchedule(withActions), pickupCode };
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
              options: ORDER_ITEM_OPTIONS_ARGS,
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
      data: (await this.withAllowedActions(orders, user.role)).map(
        withoutPayoutSchedule,
      ),
      meta: this.pagination.getPaginationMeta(page, limit, total),
    };
  }

  /**
   * Périmètre de commandes visible par un compte, et relations à charger.
   *
   * **Un seul endroit** décide de ce qu'un rôle voit. Recopier ce `if` à chaque
   * nouvelle lecture est le chemin le plus court vers une requête qui oublie le
   * cloisonnement : c'est ce qui a produit l'IDOR des analytics vendeur en
   * août, où le rôle était contrôlé mais pas l'objet.
   *
   * Minimisation des données (fix L12) : le vendeur reçoit ce qu'il lui faut
   * pour préparer et livrer — nom, téléphone, photo. Pas l'e-mail, qui n'a
   * aucun usage opérationnel et alimente les exports sauvages.
   */
  /**
   * Ajoute à chaque commande les gestes que CE rôle peut y faire (règle R1).
   * L'interrupteur d'acceptation est lu une fois pour la page, pas par ligne.
   */
  private async withAllowedActions<
    T extends {
      status: OrderStatus;
      isDelivery: boolean;
      deliveryProof?: string | null;
    },
  >(
    orders: T[],
    role: string,
  ): Promise<Array<T & { allowedActions: OrderAction[] }>> {
    return withAllowedActions(
      orders,
      role,
      await readActionContext(this.prisma),
    );
  }

  private async resolveOrderScope(firebaseUid: string): Promise<{
    scope: Prisma.OrderWhereInput;
    include: object;
    role: string;
  }> {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const baseInclude = {
      items: {
        include: {
          product: { select: { nom: true, imageUrl: true } },
          options: ORDER_ITEM_OPTIONS_ARGS,
        },
      },
      restaurant: { select: { nom: true } },
    };

    if (user.role === 'ADMIN') {
      return {
        role: user.role,
        // PERFORMANCE (fix P1) : `order.count()` sans `where` force un scan
        // séquentiel complet de la table à CHAQUE page. On borne sur les
        // commandes non supprimées, ce qui laisse PostgreSQL utiliser un index
        // et évite d'annoncer un total incluant les soft-deletes.
        scope: { deleteCommande: false },
        include: {
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
        },
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

    return {
      role: user.role,
      scope: { restaurantId: restaurant.id },
      include: {
        ...baseInclude,
        user: { select: { id: true, nom: true, phone: true, imageUrl: true } },
      },
    };
  }

  /**
   * Combien de commandes sont **bloquées**, et depuis combien de temps.
   *
   * ## Ce que « bloquée » veut dire
   *
   * Les trois états où Lilia détient l'argent du client et où personne n'a
   * encore livré : `PAYER` (payée, le vendeur ne l'a pas ouverte),
   * `EN_PREPARATION` (en cuisine trop longtemps), `PRET` (prête, aucun livreur
   * ne l'a prise).
   *
   * Deux exclusions volontaires :
   *
   * - **`EN_ATTENTE`** — la commande n'est pas payée, et `OrderExpiryService`
   *   la ferme seul au bout de 45 min. L'alerte du tableau de bord l'incluait
   *   et se remplissait donc de paniers abandonnés, qui noyaient les cas réels.
   * - **`EN_ROUTE`** — quelqu'un la porte. Un retard s'y traite dans le flux de
   *   livraison (incident `DRIVER_NO_SHOW`), pas ici.
   *
   * ## Le piège des précommandes
   *
   * Une précommande passée pour dans trois jours a un `createdAt` ancien **par
   * construction**. Sans la garde sur `scheduledFor`, l'alerte annoncerait
   * « bloquée depuis 4 320 minutes » sur une commande parfaitement normale — et
   * un opérateur apprend vite à ignorer une alerte qui se trompe.
   */
  async countStuckOrders(firebaseUid: string, minutes = 30) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new BadRequestException(
        'Le seuil doit être un entier de 1 à 1440 minutes.',
      );
    }

    const { scope } = await this.resolveOrderScope(firebaseUid);

    const now = new Date();
    const threshold = new Date(now.getTime() - minutes * 60_000);

    const where: Prisma.OrderWhereInput = {
      ...scope,
      status: { in: [...STUCK_ORDER_STATUSES] },
      createdAt: { lte: threshold },
      OR: [
        { isPreorder: false },
        { isPreorder: true, scheduledFor: { lte: now } },
      ],
    };

    const [grouped, oldest] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: { status: true },
      }),
      this.prisma.order.findMany({
        where,
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      }),
    ]);

    const byStatus = Object.fromEntries(
      STUCK_ORDER_STATUSES.map((s) => [s, 0]),
    ) as Record<(typeof STUCK_ORDER_STATUSES)[number], number>;
    let total = 0;
    for (const row of grouped) {
      byStatus[row.status as (typeof STUCK_ORDER_STATUSES)[number]] =
        row._count.status;
      total += row._count.status;
    }

    return {
      data: {
        thresholdMinutes: minutes,
        total,
        byStatus,
        // `null` et non `0` : zéro se lirait comme « une commande vient de se
        // bloquer », alors qu'il n'y en a aucune.
        oldestMinutes: oldest[0]
          ? Math.floor((now.getTime() - oldest[0].createdAt.getTime()) / 60_000)
          : null,
      },
    };
  }

  /**
   * Récupère les commandes d'un restaurant spécifique.
   * ADMIN voit toutes les commandes de tous les restaurants.
   *
   * `status` filtre **en SQL**, et `meta.statusCounts` compte les sept statuts
   * sur le périmètre entier. Les deux ont été ajoutés en même temps que le
   * raccordement d'`/admin/orders` (audit du 09/09/2026) : l'écran Commandes
   * du Web est partagé entre ADMIN et RESTAURATEUR, et un écran dont les
   * onglets sont honnêtes pour un rôle et faux pour l'autre est pire qu'un
   * écran uniformément faux — personne ne sait lequel il regarde.
   */
  async findRestaurantOrders(
    firebaseUid: string,
    page = 1,
    limit = 20,
    status?: string,
    search?: string,
  ) {
    // Le refus d'un statut inconnu vient avant toute requête : inutile de
    // solliciter la base pour une demande qu'on sait invalide.
    const statusFilter = parseOrderStatusFilter(status);
    const searchFilter = buildOrderSearchWhere(search);

    const {
      scope: baseScope,
      include,
      role,
    } = await this.resolveOrderScope(firebaseUid);

    // ⚠️ La recherche s'ajoute au cloisonnement, elle ne s'y substitue jamais :
    // elle ne doit pas devenir une porte vers les commandes d'un concurrent.
    const scope: Prisma.OrderWhereInput = { ...baseScope, ...searchFilter };

    // `scope` sert aux compteurs, `where` à la page affichée. Les deux doivent
    // porter sur la même population, filtre de statut mis à part — sinon les
    // nombres des onglets ne s'additionnent pas au total annoncé.
    const where: Prisma.OrderWhereInput = statusFilter
      ? { ...scope, status: statusFilter }
      : scope;

    const [orders, total, grouped] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: scope,
        _count: { status: true },
      }),
    ]);

    return {
      data: await this.withAllowedActions(orders, role),
      meta: {
        ...this.pagination.getPaginationMeta(page, limit, total),
        statusCounts: toOrderStatusCounts(grouped),
      },
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
            include: {
              product: { select: { nom: true, imageUrl: true } },
              options: ORDER_ITEM_OPTIONS_ARGS,
            },
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

/**
 * L'échéance de versement au vendeur ne regarde pas le client (F3-07) : elle
 * reste lisible par le vendeur et l'admin, pas dans les lectures client.
 */
function withoutPayoutSchedule<T extends { payoutDueAt?: Date | null }>(
  order: T,
): Omit<T, 'payoutDueAt'> {
  const { payoutDueAt: _payoutDueAt, ...rest } = order;
  return rest;
}
