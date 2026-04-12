/* eslint-disable prettier/prettier */
// orders/stock.service.ts
import { Injectable } from '@nestjs/common';
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

    // UPDATE atomique — pas de SELECT avant
    // stockRestant ne descend jamais en dessous de 0 grâce au GREATEST
    const productUpdates = productIds.map((id) =>
      tx.$executeRaw`
        UPDATE "Product"
        SET "stockRestant" = GREATEST(0, "stockRestant" - ${qtyByProduct.get(id)})
        WHERE id = ${id} AND "stockRestant" IS NOT NULL
      `,
    );

    const menuUpdates = menuIds.map((id) =>
      tx.$executeRaw`
        UPDATE "MenuDuJour"
        SET "stockRestant" = GREATEST(0, "stockRestant" - ${qtyByMenu.get(id)})
        WHERE id = ${id} AND "stockRestant" IS NOT NULL
      `,
    );

    await Promise.all([...productUpdates, ...menuUpdates]);
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