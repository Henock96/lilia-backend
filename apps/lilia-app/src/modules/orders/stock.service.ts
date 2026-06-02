/* eslint-disable prettier/prettier */
// orders/stock.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class StockService {

  // Utilise UPDATE avec WHERE conditionnel — atomique en SQL, pas de read-then-write
  async decrementInTransaction(
    tx: Prisma.TransactionClient,
    cartItems: any[],
  ): Promise<void> {
    // Quantités par produit
    const qtyByProduct = new Map<string, number>();
    const qtyByMenu = new Map<string, number>();

    for (const item of cartItems) {
      qtyByProduct.set(
        item.productId,
        (qtyByProduct.get(item.productId) ?? 0) + item.quantite,
      );
      if (item.menuId) {
        qtyByMenu.set(
          item.menuId,
          (qtyByMenu.get(item.menuId) ?? 0) + item.quantite,
        );
      }
    }

    const [limitedProducts, limitedMenus] = await Promise.all([
      tx.product.findMany({
        where: {
          id: { in: [...qtyByProduct.keys()] },
          stockRestant: { not: null },
        },
        select: { id: true },
      }),
      tx.menuDuJour.findMany({
        where: {
          id: { in: [...qtyByMenu.keys()] },
          stockRestant: { not: null },
        },
        select: { id: true },
      }),
    ]);

    const productIds = limitedProducts.map((product) => product.id);
    const menuIds = limitedMenus.map((menu) => menu.id);

    // UPDATE atomique avec vérification du stock dans la même requête.
    // WHERE stockRestant >= qty garantit qu'on ne vend pas ce qu'on n'a pas.
    // Si 0 lignes mises à jour → le stock a été épuisé entre la validation et la transaction.
    const productUpdates = productIds.map((id) => {
      const qty = qtyByProduct.get(id) ?? 0;
      return tx.$executeRaw`
        UPDATE "Product"
        SET "stockRestant" = "stockRestant" - ${qty}
        WHERE id = ${id}
          AND "stockRestant" IS NOT NULL
          AND "stockRestant" >= ${qty}
      `;
    });

    const menuUpdates = menuIds.map((id) => {
      const qty = qtyByMenu.get(id) ?? 0;
      return tx.$executeRaw`
        UPDATE "MenuDuJour"
        SET "stockRestant" = "stockRestant" - ${qty}
        WHERE id = ${id}
          AND "stockRestant" IS NOT NULL
          AND "stockRestant" >= ${qty}
      `;
    });

    const [productResults, menuResults] = await Promise.all([
      Promise.all(productUpdates),
      Promise.all(menuUpdates),
    ]);

    if (productResults.some((n) => n === 0)) {
      throw new BadRequestException(
        'Stock épuisé pour un ou plusieurs produits. Veuillez mettre à jour votre panier.',
      );
    }
    if (menuResults.some((n) => n === 0)) {
      throw new BadRequestException(
        'Stock épuisé pour un ou plusieurs menus. Veuillez mettre à jour votre panier.',
      );
    }
  }

  /**
   * Restaure le stock pour une liste d'OrderItem (utilisé lors de l'annulation
   * d'une commande EN_ATTENTE qui avait décrémenté le stock au checkout).
   *
   * - `stockRestant IS NULL` = stock illimité → on ne touche pas
   * - Sinon : on incrémente atomiquement de `quantite`
   *
   * Items attendus : `{ productId: string, menuId: string | null, quantite: number }`.
   */
  async restoreInTransaction(
    tx: Prisma.TransactionClient,
    items: Array<{ productId: string; menuId: string | null; quantite: number }>,
  ): Promise<void> {
    const qtyByProduct = new Map<string, number>();
    const qtyByMenu = new Map<string, number>();

    for (const item of items) {
      if (item.productId) {
        qtyByProduct.set(
          item.productId,
          (qtyByProduct.get(item.productId) ?? 0) + item.quantite,
        );
      }
      if (item.menuId) {
        qtyByMenu.set(
          item.menuId,
          (qtyByMenu.get(item.menuId) ?? 0) + item.quantite,
        );
      }
    }

    const productUpdates = [...qtyByProduct.entries()].map(([id, qty]) =>
      tx.$executeRaw`
        UPDATE "Product"
        SET "stockRestant" = "stockRestant" + ${qty}
        WHERE id = ${id}
          AND "stockRestant" IS NOT NULL
      `,
    );

    const menuUpdates = [...qtyByMenu.entries()].map(([id, qty]) =>
      tx.$executeRaw`
        UPDATE "MenuDuJour"
        SET "stockRestant" = "stockRestant" + ${qty}
        WHERE id = ${id}
          AND "stockRestant" IS NOT NULL
      `,
    );

    await Promise.all([
      Promise.all(productUpdates),
      Promise.all(menuUpdates),
    ]);
  }

  // Reset quotidien (appelé par le scheduler à minuit)
  async resetDailyStock(tx: Prisma.TransactionClient): Promise<void> {
    await Promise.all([
      tx.$executeRaw`
        UPDATE "Product"
        SET "stockRestant" = "stockQuotidien"
        WHERE "stockQuotidien" IS NOT NULL
      `,
      tx.$executeRaw`
        UPDATE "MenuDuJour"
        SET "stockRestant" = "stockQuotidien"
        WHERE "stockQuotidien" IS NOT NULL AND "isActive" = true
      `,
    ]);
  }
}
