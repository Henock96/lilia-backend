/* eslint-disable prettier/prettier */
// orders/stock.service.ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  insufficientStockMessage,
  outOfStockError,
  requiredStock,
  stockConsumptionOf,
  type StockLine,
} from './stock-units';

/** Ligne réservable : une ligne de panier, avec de quoi nommer le refus. */
export type ReservableLine = StockLine & {
  variantId?: string | null;
  product?: { nom?: string | null; restaurantId?: string } | null;
  variant?: { stockConsumption?: number | null; label?: string | null } | null;
};

/** Ligne de commande restituable (figé F3-10, ou `NULL` si antérieure). */
export interface RestorableItem {
  productId: string;
  menuId?: string | null;
  quantite: number;
  stockUnitsReserved?: number | null;
}

/** Compteur touché : alimente l'invalidation du catalogue (après commit). */
export interface StockMovement {
  productId: string;
  before: number;
  after: number;
}

export interface ReservationResult {
  /** Produits limités au moment de la réservation (lus sous verrou). */
  limitedProductIds: string[];
  movements: StockMovement[];
}

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  /**
   * Réserve le stock d'un panier — **l'arbitre** du checkout.
   *
   * F3-10 : chaque ligne pèse `quantite × stockConsumption` unités (1 carton de
   * 6 = 6 bouteilles), agrégées par produit. Bouteille et carton puisent dans
   * **le même** compteur, donc contendent sur la même ligne `Product` : aucune
   * combinaison ne peut vendre plus que le stock.
   *
   * ### Déroulé (allers-retours fixes, contre 1 + N avant)
   *
   * 1. `SELECT … ORDER BY id FOR UPDATE` : tous les verrous produits d'un coup,
   *    dans un ordre total (fix S-7 — deux paniers qui se croisent ne peuvent
   *    pas s'interbloquer). L'état lu est l'état qu'on écrira ;
   * 2. contrôle en mémoire, nominatif (on tient les verrous : le nombre lu est
   *    exact) ;
   * 3. `UPDATE … FROM unnest(…)` groupé, garde `>= u` conservée en ceinture ;
   * 4. idem pour les menus — **toujours après** les produits (ordre des tables).
   *
   * Corrige au passage un défaut : un produit rendu illimité entre la lecture
   * des produits limités et l'`UPDATE` faisait échouer la commande en « Stock
   * épuisé » (0 ligne affectée). Sous verrou, cela ne peut plus arriver.
   *
   * Pas de verrou `ProductVariant` : la consommation est immuable (trigger
   * `ProductVariant_stock_consumption_immutable`), la lire hors transaction est
   * donc sûr — et un verrou de variante prendrait l'ordre inverse des écritures
   * vendeur (`Product` puis `ProductVariant`).
   */
  async decrementInTransaction(
    tx: Prisma.TransactionClient,
    cartItems: readonly ReservableLine[],
  ): Promise<ReservationResult> {
    const { byProduct, byMenu } = requiredStock(cartItems);
    const movements: StockMovement[] = [];

    const productIds = [...byProduct.keys()].sort();
    const locked = productIds.length
      ? await tx.$queryRaw<{ id: string; stockRestant: number | null }[]>`
          SELECT id, "stockRestant" FROM "Product"
           WHERE id = ANY(${productIds}::text[])
           ORDER BY id
             FOR UPDATE`
      : [];
    const limited = locked.filter((row) => row.stockRestant !== null);

    for (const row of limited) {
      if (row.stockRestant! < byProduct.get(row.id)!) {
        throw this.productShortage(cartItems, row.id, row.stockRestant!);
      }
    }

    if (limited.length > 0) {
      const ids = limited.map((row) => row.id);
      const units = limited.map((row) => byProduct.get(row.id)!);
      const updated = await tx.$queryRaw<{ id: string; stockRestant: number }[]>`
        UPDATE "Product" p
           SET "stockRestant" = p."stockRestant" - x.u
          FROM unnest(${ids}::text[], ${units}::int[]) AS x(id, u)
         WHERE p.id = x.id
           AND p."stockRestant" IS NOT NULL
           AND p."stockRestant" >= x.u
        RETURNING p.id, p."stockRestant"`;
      if (updated.length !== limited.length) {
        // Impossible sous verrou : si cela arrive, un invariant est rompu.
        this.logger.error(`[STOCK] invariant rompu : ${updated.length}/${limited.length} lignes décrémentées`);
        throw new BadRequestException({
          message: 'Stock épuisé pour un ou plusieurs produits. Veuillez mettre à jour votre panier.',
          code: 'OUT_OF_STOCK',
        });
      }
      for (const row of updated) {
        movements.push({
          productId: row.id,
          before: row.stockRestant + byProduct.get(row.id)!,
          after: row.stockRestant,
        });
      }
    }

    const menuIds = [...byMenu.keys()].sort();
    if (menuIds.length > 0) {
      const menus = await tx.$queryRaw<{ id: string; nom: string; stockRestant: number | null }[]>`
        SELECT id, nom, "stockRestant" FROM "MenuDuJour"
         WHERE id = ANY(${menuIds}::text[])
         ORDER BY id
           FOR UPDATE`;
      const limitedMenus = menus.filter((m) => m.stockRestant !== null);
      for (const menu of limitedMenus) {
        if (menu.stockRestant! < byMenu.get(menu.id)!) {
          throw new BadRequestException({
            message:
              menu.stockRestant === 0
                ? `Menu « ${menu.nom} » épuisé.`
                : `Menu « ${menu.nom} » : il n'en reste que ${menu.stockRestant}.`,
            code: 'OUT_OF_STOCK',
            menuId: menu.id,
            availableQuantity: menu.stockRestant,
          });
        }
      }
      if (limitedMenus.length > 0) {
        await tx.$executeRaw`
          UPDATE "MenuDuJour" m
             SET "stockRestant" = m."stockRestant" - x.q
            FROM unnest(${limitedMenus.map((m) => m.id)}::text[],
                        ${limitedMenus.map((m) => byMenu.get(m.id)!)}::int[]) AS x(id, q)
           WHERE m.id = x.id AND m."stockRestant" >= x.q`;
      }
    }

    return { limitedProductIds: limited.map((row) => row.id), movements };
  }

  /**
   * Fige, ligne par ligne, ce que la réservation a réellement pris :
   * `quantite × stockUnitsPerItem` pour un produit limité, `0` sinon. Un seul
   * aller-retour, dans la transaction du checkout.
   *
   * C'est ce nombre — et lui seul — que la restitution rendra. Un produit
   * illimité au checkout puis limité ensuite ne se voit rien « rendre » qu'il
   * n'a pas donné (défaut d'avant F3-10 : `+q` fabriqué).
   */
  async recordReservation(
    tx: Prisma.TransactionClient,
    orderId: string,
    limitedProductIds: readonly string[],
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "OrderItem"
         SET "stockUnitsReserved" = CASE
               WHEN "productId" = ANY(${[...limitedProductIds]}::text[])
               THEN "quantite" * COALESCE("stockUnitsPerItem", 1)
               ELSE 0 END
       WHERE "orderId" = ${orderId}`;
  }

  /**
   * Restitue le stock réservé par une commande annulée.
   *
   * F3-10 — on rend **le figé** (`stockUnitsReserved`), jamais un recalcul
   * depuis le catalogue : 1 carton de 6 annulé = +6, 3 bouteilles = +3, une
   * ligne d'un produit illimité au checkout = +0. Une commande antérieure à
   * F3-10 (`NULL`) garde l'ancienne règle : `quantite` si le produit est limité
   * (toutes les consommations valaient 1 — c'est exact).
   *
   * Selon la politique du produit :
   * - `DAILY_QUOTA` : rien si la commande précède le dernier reset (le reset a
   *   déjà effacé sa réservation — la rendre fabriquerait des unités dans le
   *   quota du jour). Plafond au quota conservé en ceinture (fix L8) ;
   * - `INVENTORY` : restitution exacte, **sans** plafond : « dernier niveau
   *   déclaré » n'a pas de sens pour un stock réel, et le plafond perdait des
   *   unités après un réapprovisionnement ;
   * - `UNLIMITED` : rien (`stockRestant IS NULL`).
   *
   * `zeroProductIds` : produits que le vendeur déclare en rupture en refusant
   * la commande — non restitués (voir `markOutOfStock`).
   *
   * Idempotence : inchangée, portée par la transition verrouillée vers
   * `ANNULER` — une seule transaction peut la gagner. Même discipline de
   * verrous que la réservation : produits triés, puis menus.
   */
  async restoreInTransaction(
    tx: Prisma.TransactionClient,
    items: readonly RestorableItem[],
    context: { orderCreatedAt?: Date; zeroProductIds?: readonly string[] } = {},
  ): Promise<StockMovement[]> {
    const movements: StockMovement[] = [];
    const skip = new Set(context.zeroProductIds ?? []);
    const units = new Map<string, number>();
    for (const item of items) {
      if (!item.productId || skip.has(item.productId)) continue;
      const u =
        item.stockUnitsReserved === null || item.stockUnitsReserved === undefined
          ? item.quantite
          : item.stockUnitsReserved;
      if (u <= 0) continue;
      units.set(item.productId, (units.get(item.productId) ?? 0) + u);
    }
    // Colonnes `timestamp(3)` sans fuseau, écrites en UTC par Prisma : on
    // compare en UTC explicite, indépendamment du fuseau de la session.
    const since = context.orderCreatedAt?.toISOString() ?? null;

    // Un `UPDATE` par produit, ids triés : l'ordre des verrous est celui de la
    // réservation (un `UPDATE … FROM unnest` ne garantit pas l'ordre dans
    // lequel PostgreSQL verrouille les lignes).
    for (const id of [...units.keys()].sort()) {
      const u = units.get(id)!;
      const rows = await tx.$queryRaw<{ stockRestant: number; before: number }[]>`
        UPDATE "Product"
           SET "stockRestant" = CASE
                 WHEN "stockPolicy" = 'DAILY_QUOTA'
                 THEN LEAST("stockRestant" + ${u}, COALESCE("stockQuotidien", "stockRestant" + ${u}))
                 ELSE "stockRestant" + ${u} END
         WHERE id = ${id}
           AND "stockRestant" IS NOT NULL
           AND ("stockPolicy" <> 'DAILY_QUOTA'
                OR ${since}::text IS NULL
                OR "stockResetAt" IS NULL
                OR "stockResetAt" <= (${since}::timestamptz AT TIME ZONE 'UTC'))
        RETURNING "stockRestant", ${u}::int AS before`;
      for (const row of rows) {
        movements.push({ productId: id, before: row.stockRestant - row.before, after: row.stockRestant });
      }
    }
    if (units.size > 0) {
      this.logger.log(
        `[STOCK] restitution ${[...units].map(([id, u]) => `${id}+${u}`).join(', ')}`,
      );
    }

    const qtyByMenu = requiredStock(items).byMenu;
    for (const id of [...qtyByMenu.keys()].sort()) {
      const qty = qtyByMenu.get(id)!;
      await tx.$executeRaw`
        UPDATE "MenuDuJour"
        SET "stockRestant" = LEAST(
              "stockRestant" + ${qty},
              COALESCE("stockQuotidien", "stockRestant" + ${qty})
            )
        WHERE id = ${id} AND "stockRestant" IS NOT NULL
      `;
    }
    return movements;
  }

  /**
   * Refus vendeur « rupture » : les produits désignés passent à 0 ; un produit
   * sans compteur passe indisponible. Dans la transaction du refus, bornée au
   * vendeur de la commande (un identifiant étranger n'a aucun effet).
   */
  async markOutOfStock(
    tx: Prisma.TransactionClient,
    restaurantId: string,
    productIds: readonly string[],
  ): Promise<void> {
    for (const id of [...productIds].sort()) {
      await tx.$executeRaw`
        UPDATE "Product"
           SET "isAvailable"  = CASE WHEN "stockRestant" IS NULL THEN false ELSE "isAvailable" END,
               "stockRestant" = CASE WHEN "stockRestant" IS NULL THEN NULL ELSE 0 END
         WHERE id = ${id} AND "restaurantId" = ${restaurantId}`;
    }
    if (productIds.length > 0) {
      this.logger.warn(`[STOCK] rupture déclarée au refus : ${[...productIds].join(', ')}`);
    }
  }

  /** Refus nominatif, dans l'unité du format demandé. */
  private productShortage(
    lines: readonly ReservableLine[],
    productId: string,
    stockRestant: number,
  ): BadRequestException {
    const productLines = lines.filter((l) => l.productId === productId);
    // Le format le plus « gros » est celui qui manque : on nomme celui-là.
    const line = productLines.reduce((a, b) =>
      stockConsumptionOf(b) > stockConsumptionOf(a) ? b : a,
    );
    const consumption = stockConsumptionOf(line);
    const others = productLines
      .filter((l) => l !== line)
      .reduce((sum, l) => sum + l.quantite * stockConsumptionOf(l), 0);
    const available = Math.max(0, Math.floor((stockRestant - others) / consumption));
    this.logger.warn(
      `[STOCK] réservation refusée produit=${productId} restant=${stockRestant}`,
    );
    return outOfStockError({
      message: insufficientStockMessage({
        productName: line.product?.nom ?? 'Ce produit',
        variantLabel: line.variant?.label,
        stockConsumption: consumption,
        available,
      }),
      productId,
      variantId: line.variantId,
      availableQuantity: available,
    });
  }

  // ─── Où est passé `resetDailyStock` ? ────────────────────────────────────
  //
  // Supprimé (fix S-5, audit du 05/09/2026) : il omettait `stockMode = DAILY`
  // et aurait rechargé chaque nuit le stock réel des épiceries. Le reset n'a
  // **qu'une** implémentation, dans
  // `modules/schedule/restaurant-schedule.service.ts`.
}
