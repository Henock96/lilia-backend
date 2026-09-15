import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  parseOrderStatusFilter,
  toOrderStatusCounts,
} from '../orders/order-status-filter';
import { buildOrderSearchWhere } from '../orders/order-search';

/**
 * Relations chargées avec chaque commande de la vue d'administration.
 *
 * `user.phone` et `delivery` y figurent parce qu'ils conditionnent ce qu'un
 * opérateur peut **faire** ensuite : rappeler le client, savoir qui porte la
 * commande, décider s'il faut réassigner. Sans eux, tout incident se traite en
 * rouvrant Prisma Studio à côté.
 *
 * `email` n'y est **pas** : aucune interface ne l'affiche et il alimentait les
 * exports sauvages. Même minimisation que côté vendeur (fix L12).
 */
const ADMIN_ORDER_INCLUDE = {
  restaurant: { select: { id: true, nom: true, vendorType: true } },
  user: { select: { id: true, nom: true, phone: true, imageUrl: true } },
  items: { include: { product: { select: { nom: true, imageUrl: true } } } },
  delivery: {
    select: {
      id: true,
      status: true,
      delivererId: true,
      deliverer: { select: { id: true, nom: true, phone: true } },
    },
  },
} satisfies Prisma.OrderInclude;

export interface AdminOrderListParams {
  page?: number;
  limit?: number;
  status?: string;
  /** Recherche libre — identifiant, nom du client, téléphone, nom du vendeur. */
  search?: string;
}

/**
 * Vue d'administration des commandes — **toutes** les commandes de la
 * plateforme, paginées et filtrables.
 *
 * ## Pourquoi ce service existe
 *
 * `GET /admin/orders` était servi par une méthode de `AdminService` qui rendait
 * `{ data, total, page, limit }` et n'avait aucun appelant. Les deux
 * administrations lisaient `GET /orders/restaurant` — la route **vendeur** —
 * sans transmettre de pagination : le serveur appliquait donc son défaut de 20,
 * et les deux interfaces affichaient les vingt dernières commandes de toute la
 * plateforme, sans page suivante ni recherche. Une commande plus ancienne était
 * inatteignable depuis l'administration (audit du 09/09/2026, blocker n°1).
 *
 * ## Ce que le service garantit
 *
 * - `meta.total` : le nombre réel de commandes du périmètre courant. Sans lui,
 *   un front compte les éléments reçus et annonce la taille de la page.
 * - `meta.statusCounts` : le compte par statut sur le **périmètre entier**,
 *   filtre de statut exclu. Les onglets doivent rester lisibles quand on en
 *   sélectionne un ; les recalculer sur la page courante donnait des nombres
 *   qui changeaient selon la page consultée.
 * - le filtre de statut est appliqué en SQL. Filtrer une page déjà tronquée ne
 *   rend que les commandes de cette page — c'est la forme la plus trompeuse du
 *   défaut, parce qu'elle affiche « aucune commande en attente » avec aplomb.
 */
@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: AdminOrderListParams) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    // Même règle que `/orders/restaurant` — importée, pas recopiée : les deux
    // routes servent la même liste, et deux copies d'une règle divergent.
    const status = parseOrderStatusFilter(params.status);

    // Périmètre commun à la liste, au total et aux compteurs d'onglets. Les
    // trois doivent compter la même population, sans quoi les nombres affichés
    // ne s'additionnent pas.
    //
    // La recherche fait partie du périmètre, le statut n'en est qu'une
    // facette : chercher « Marie » doit dire combien de commandes de Marie
    // sont dans chaque statut, pas combien il y en a dans toute la plateforme.
    const search = buildOrderSearchWhere(params.search);
    const scope: Prisma.OrderWhereInput = {
      deleteCommande: false,
      ...search,
    };
    const where: Prisma.OrderWhereInput = status ? { ...scope, status } : scope;

    const [orders, total, grouped] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ADMIN_ORDER_INCLUDE,
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
      data: orders,
      meta: {
        total,
        page,
        limit,
        // `Math.ceil(0 / 20)` vaut 0, et « page 1/0 » se lit comme une erreur.
        totalPages: Math.max(1, Math.ceil(total / limit)),
        statusCounts: toOrderStatusCounts(grouped),
      },
    };
  }
}
