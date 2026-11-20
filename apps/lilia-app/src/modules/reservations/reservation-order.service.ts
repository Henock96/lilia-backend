import { ConflictException, HttpException, Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  CartLine,
  lineTotalsXaf,
  priceCartLines,
  PricedCartLine,
} from '../modifiers/cart-line-pricing';
import { PRODUCT_MODIFIER_GROUPS_ARGS } from '../modifiers/modifier-catalog';
import { ModifierSelectionError } from '../modifiers/modifier-selection';
import {
  OrderAmounts,
  OrderCalculatorService,
} from '../orders/order-calculator.service';
import { OrderTransitionService } from '../orders/order-transition.service';
import { OrderValidatorService } from '../orders/order-validator.service';
import { serviceFeeBasisPoints } from '../orders/service-fee';
import { StockService } from '../orders/stock.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { brazzavilleClock } from '../vendors/vendor-opening.policy';
import { BOOKING_ERROR_CODES as CODES } from './reservation-booking-vocab';

type Db = Prisma.TransactionClient;

/** Ce que la commande liée lit d'une réservation. */
export interface ReservationForOrder {
  id: string;
  restaurantId: string;
  userId: string;
  arrivalAt: Date;
  contactPhone: string;
  items: ReadonlyArray<{
    id: string;
    productId: string;
    menuId: string | null;
    variantId: string;
    quantite: number;
    optionsSignature: string;
    productName: string;
    options: ReadonlyArray<{ optionId: string; quantity: number }>;
  }>;
}

/** Montants et lignes chiffrées, calculés hors transaction. */
export interface PreparedLinkedOrder {
  priced: PricedCartLine[];
  amounts: OrderAmounts;
  /** OD-11 — le quota du jour ne compte que pour une arrivée du jour. */
  sameDay: boolean;
}

/**
 * Lot 4 (4B-2) — la commande liée d'une réservation, née à l'acceptation du
 * restaurant (OD-03 ; I-01 : parcours `ACCEPT_FIRST`).
 *
 * - **Le serveur fixe le montant** (règle 2) : lignes reconstituées depuis la
 *   précommande, relues contre le catalogue **courant**, chiffrées par les
 *   fonctions du checkout (`priceCartLines`, `OrderCalculatorService`). Le
 *   prix indicatif de la demande n'est jamais facturé.
 * - Plats jugés à l'heure d'arrivée (OD-12) ; un plat retiré, indisponible ou
 *   hors créneau refuse l'acceptation (409 nominatif), rien n'est écrit.
 * - Ni promo, ni points, ni offre vendeur (OD-13), aucun minimum (D6), pas de
 *   livraison.
 * - La commande naît `EN_ATTENTE`, **déjà acceptée** (`acceptedAt`), payable
 *   jusqu'à l'échéance de la réservation (`paymentDueAt`) : le chemin de
 *   paiement existant s'applique sans modification.
 */
@Injectable()
export class ReservationOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: OrderValidatorService,
    private readonly calculator: OrderCalculatorService,
    private readonly stock: StockService,
    private readonly transitions: OrderTransitionService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  /**
   * Hors transaction : reconstitue, valide et chiffre la précommande. Lève
   * 409 `RESERVATION_ITEMS_UNAVAILABLE` en nommant les plats en cause.
   */
  async prepare(
    r: ReservationForOrder,
    now: Date,
  ): Promise<PreparedLinkedOrder> {
    const settings = await this.platformSettings.getSettings();
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: r.restaurantId },
      select: { vendorType: true, commissionPercent: true },
    });
    const lines = await loadReservationLines(this.prisma, r);
    const sameDay =
      brazzavilleClock(r.arrivalAt).isoDate === brazzavilleClock(now).isoDate;
    try {
      await this.validator.validateStock(lines, {
        at: r.arrivalAt,
        dailyStock: sameDay,
      });
    } catch (error) {
      throw itemsUnavailable(clientMessageOf(error));
    }
    let priced: PricedCartLine[];
    try {
      priced = priceCartLines(lines, settings.modifiersEnabled);
    } catch (error) {
      if (error instanceof ModifierSelectionError) {
        throw itemsUnavailable(error.message);
      }
      throw error;
    }
    const amounts = this.calculator.calculate(
      priced,
      0,
      false,
      serviceFeeBasisPoints(settings, restaurant.vendorType),
      // Même résolution que le checkout : le taux du vendeur, sinon celui de
      // la plateforme, figé sur la commande.
      restaurant.commissionPercent ?? settings.restaurantCommissionPercent,
    );
    return { priced, amounts, sameDay };
  }

  /**
   * Dans la transaction de `PENDING → AWAITING_PAYMENT` : commande, lignes
   * figées, historique, stock (arrivée du jour seulement, OD-11). L'index
   * unique `reservationId` arbitre deux acceptations simultanées.
   */
  async createInTransaction(
    tx: Db,
    r: ReservationForOrder,
    prepared: PreparedLinkedOrder,
    p: { now: Date; paymentDueAt: Date; acceptedBy: string },
  ): Promise<{ orderId: string; total: number }> {
    const { amounts, priced } = prepared;
    const snapshots = this.calculator.buildOrderItemSnapshots(priced);
    const order = await tx.order.create({
      data: {
        userId: r.userId,
        restaurantId: r.restaurantId,
        reservationId: r.id,
        subTotal: amounts.subTotal,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        serviceFee: amounts.serviceFee,
        commissionPercent: amounts.commissionPercent,
        commissionAmount: amounts.commissionAmount,
        discountAmount: 0,
        total: amounts.total,
        isDelivery: false,
        contactPhone: r.contactPhone,
        // Provisoire : l'opérateur réel est celui que le client choisit en
        // payant (`Payment.method`, et la route de paiement le recopie ici).
        paymentMethod: PaymentMethod.MTN_MOMO,
        status: 'EN_ATTENTE',
        orderFlow: 'ACCEPT_FIRST',
        acceptedAt: p.now,
        paymentDueAt: p.paymentDueAt,
        isPreorder: true,
        scheduledFor: r.arrivalAt,
        items: {
          create: snapshots.map((snap) => ({
            productId: snap.productId,
            menuId: snap.menuId,
            quantite: snap.quantite,
            prix: snap.prix,
            variant: snap.variant,
            variantId: snap.variantId,
            variantLabel: snap.variant,
            snapshotPrice: snap.snapshotPrice,
            stockUnitsPerItem: snap.stockUnitsPerItem,
            stockUnit: snap.stockUnit,
            optionsTotalXaf: snap.optionsTotalXaf,
            options: {
              create: snap.options.map((option) => ({
                optionId: option.optionId,
                groupId: option.groupId,
                groupName: option.groupName,
                optionName: option.optionName,
                priceDeltaXaf: option.priceDeltaXaf,
                quantity: option.quantity,
                position: option.position,
              })),
            },
          })),
        },
      },
      select: { id: true, total: true },
    });
    await this.transitions.recordCreation(tx, {
      orderId: order.id,
      to: 'EN_ATTENTE',
      actor: 'RESTAURATEUR',
      actorUserId: p.acceptedBy,
      source: 'APP',
      reason: 'Réservation acceptée par le restaurant',
    });
    // OD-11 — une arrivée d'un autre jour ne consomme pas le quota du jour ;
    // `stockUnitsReserved = 0` est alors écrit explicitement, pour que
    // l'annulation ne « rende » rien qu'elle n'a pas pris.
    let limitedProductIds: string[] = [];
    if (prepared.sameDay) {
      try {
        const reserved = await this.stock.decrementInTransaction(
          tx,
          priced.map(({ line }) => line),
        );
        limitedProductIds = reserved.limitedProductIds;
      } catch (error) {
        throw itemsUnavailable(clientMessageOf(error));
      }
    }
    await this.stock.recordReservation(tx, order.id, limitedProductIds);
    return { orderId: order.id, total: order.total };
  }
}

/**
 * P-04 — part **indicative** de chaque ligne dans le sous-total, à la
 * demande (règle des menus comprise). Jamais facturée.
 */
export function indicativeLineTotals(
  priced: readonly PricedCartLine[],
): number[] {
  return lineTotalsXaf(priced);
}

/**
 * Reconstitue les lignes « panier » d'une précommande à partir du catalogue
 * courant. Un produit, une variante, un menu ou une option qui n'existe plus
 * (ou plus chez ce restaurant) rend la ligne indisponible.
 */
async function loadReservationLines(
  db: PrismaService,
  r: ReservationForOrder,
): Promise<CartLine[]> {
  const productIds = [...new Set(r.items.map((i) => i.productId))];
  const variantIds = [...new Set(r.items.map((i) => i.variantId))];
  const menuIds = [
    ...new Set(r.items.map((i) => i.menuId).filter((m): m is string => !!m)),
  ];
  const optionIds = [
    ...new Set(r.items.flatMap((i) => i.options.map((o) => o.optionId))),
  ];
  const [products, variants, menus, options] = await Promise.all([
    db.product.findMany({
      where: { id: { in: productIds }, restaurantId: r.restaurantId },
      include: { modifierGroups: PRODUCT_MODIFIER_GROUPS_ARGS },
    }),
    db.productVariant.findMany({ where: { id: { in: variantIds } } }),
    db.menuDuJour.findMany({
      where: { id: { in: menuIds }, restaurantId: r.restaurantId },
      select: { id: true, nom: true, prix: true, imageUrl: true },
    }),
    db.modifierOption.findMany({
      where: { id: { in: optionIds } },
      select: {
        id: true,
        name: true,
        priceDeltaXaf: true,
        group: { select: { id: true, name: true } },
      },
    }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const menuById = new Map(menus.map((m) => [m.id, m]));
  const optionById = new Map(options.map((o) => [o.id, o]));

  const missing = new Set<string>();
  const lines: CartLine[] = [];
  for (const item of r.items) {
    const product = productById.get(item.productId);
    const variant = variantById.get(item.variantId);
    const menu = item.menuId ? menuById.get(item.menuId) : undefined;
    const chosen = [...item.options]
      .sort((a, b) => a.optionId.localeCompare(b.optionId))
      .map((o) => ({ ...o, option: optionById.get(o.optionId) }));
    if (
      !product ||
      !variant ||
      variant.productId !== item.productId ||
      (item.menuId !== null && !menu) ||
      chosen.some((o) => !o.option)
    ) {
      missing.add(item.productName);
      continue;
    }
    lines.push({
      id: item.id,
      cartId: r.id,
      productId: item.productId,
      menuId: item.menuId,
      variantId: item.variantId,
      quantite: item.quantite,
      optionsSignature: item.optionsSignature,
      createdAt: r.arrivalAt,
      product,
      variant,
      menu: menu ?? null,
      options: chosen.map((o) => ({
        optionId: o.optionId,
        quantity: o.quantity,
        option: {
          name: o.option!.name,
          priceDeltaXaf: o.option!.priceDeltaXaf,
          group: o.option!.group,
        },
      })),
    });
  }
  if (missing.size > 0) {
    throw itemsUnavailable(
      `${missing.size > 1 ? 'Ces plats ont été retirés' : 'Ce plat a été retiré'} de la carte : ${[...missing].join(', ')}.`,
    );
  }
  return lines;
}

/**
 * Message d'un refus du validateur ou du stock (4xx) ; toute autre erreur
 * remonte telle quelle (une panne n'est pas un plat indisponible).
 */
function clientMessageOf(error: unknown): string {
  if (!(error instanceof HttpException) || error.getStatus() >= 500) {
    throw error;
  }
  const body = error.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' ? message : error.message;
}

/** 409 nominatif : le restaurant refuse alors avec `ITEMS_UNAVAILABLE`. */
function itemsUnavailable(detail: string): ConflictException {
  return new ConflictException({
    message: `La précommande ne peut pas être acceptée telle quelle. ${detail} Refusez la demande avec le motif « plats indisponibles ».`,
    code: CODES.itemsUnavailable,
  });
}
