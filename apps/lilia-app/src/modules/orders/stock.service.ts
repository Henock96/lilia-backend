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
    // Déduplique pour ne décrémenter qu'une fois par produit/menu
    const productIds = [...new Set(cartItems.map((i) => i.productId))];
    const menuIds = [...new Set(
      cartItems.filter((i) => i.menuId).map((i) => i.menuId),
    )];

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