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

    // ⚠️ TRI OBLIGATOIRE — fix S-7 (audit du 05/09/2026).
    //
    // Ces `UPDATE` posent un verrou de ligne chacun. Deux transactions qui
    // verrouillent les mêmes lignes dans un ordre différent s'interbloquent :
    // T1 tient A et attend B, T2 tient B et attend A. PostgreSQL le détecte et
    // en avorte une — pas de corruption, mais un 500 au client à la place de
    // sa commande. Reproduit en laboratoire avant correction.
    //
    // Or `findMany` **ne garantit aucun ordre** sans `orderBy` : deux paniers
    // contenant les mêmes deux produits pouvaient parfaitement les recevoir
    // dans l'ordre inverse. Trier suffit à rendre l'interblocage impossible —
    // un ordre total commun à toutes les transactions ne peut pas se croiser.
    //
    // Le tri est fait ici, sur le résultat, et non par `orderBy` dans la
    // requête : ce qui compte est l'ordre des `UPDATE`, pas celui du `SELECT`.
    const productIds = limitedProducts.map((product) => product.id).sort();
    const menuIds = limitedMenus.map((menu) => menu.id).sort();

    // UPDATE atomique avec vérification du stock dans la même requête.
    // WHERE stockRestant >= qty garantit qu'on ne vend pas ce qu'on n'a pas.
    // Si 0 lignes mises à jour → le stock a été épuisé entre la validation et la transaction.
    //
    // ⚠️ SÉQUENTIEL, et pas `Promise.all` — suite du fix S-7.
    //
    // Trier les identifiants ne suffit pas : les deux lots (produits, menus)
    // étaient dépêchés **en parallèle**, si bien que l'entrelacement entre un
    // `UPDATE "Product"` et un `UPDATE "MenuDuJour"` restait indéterminé. Une
    // transaction pouvait tenir un produit en attendant un menu pendant que
    // l'autre tenait ce menu en attendant ce produit — un cycle, donc un
    // interblocage, malgré des identifiants triés de chaque côté.
    //
    // Un ordre déterministe **par table** ne ferme le cycle que si les tables
    // elles-mêmes sont prises dans un ordre fixe : produits d'abord, menus
    // ensuite, toujours. C'est ce que garantit la séquence.
    //
    // Le coût est nul : Prisma sérialise déjà ces requêtes sur l'unique
    // connexion de la transaction. `Promise.all` n'y apportait aucun
    // parallélisme réel — seulement l'indétermination.
    for (const id of productIds) {
      const qty = qtyByProduct.get(id) ?? 0;
      const affected = await tx.$executeRaw`
        UPDATE "Product"
        SET "stockRestant" = "stockRestant" - ${qty}
        WHERE id = ${id}
          AND "stockRestant" IS NOT NULL
          AND "stockRestant" >= ${qty}
      `;
      if (affected === 0) {
        throw new BadRequestException(
          'Stock épuisé pour un ou plusieurs produits. Veuillez mettre à jour votre panier.',
        );
      }
    }

    for (const id of menuIds) {
      const qty = qtyByMenu.get(id) ?? 0;
      const affected = await tx.$executeRaw`
        UPDATE "MenuDuJour"
        SET "stockRestant" = "stockRestant" - ${qty}
        WHERE id = ${id}
          AND "stockRestant" IS NOT NULL
          AND "stockRestant" >= ${qty}
      `;
      if (affected === 0) {
        throw new BadRequestException(
          'Stock épuisé pour un ou plusieurs menus. Veuillez mettre à jour votre panier.',
        );
      }
    }
  }

  // Restaure le stock réservé au checkout (annulation de commande).
  // Symétrique de decrementInTransaction : ré-incrémente Product ET MenuDuJour
  // pour les lignes à stock limité (stockRestant non null).
  async restoreInTransaction(
    tx: Prisma.TransactionClient,
    items: { productId: string; menuId?: string | null; quantite: number }[],
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

    // Même discipline de verrouillage que `decrementInTransaction` (fix S-7) :
    // identifiants triés, produits avant menus, écritures séquentielles.
    //
    // La restauration prend exactement les mêmes verrous que la
    // décrémentation. Deux annulations concurrentes portant sur les mêmes
    // produits — ou une annulation concurrente d'un checkout, cas bien plus
    // fréquent — pouvaient donc s'interbloquer par le même mécanisme. Un ordre
    // total ne vaut que s'il est le **même** partout : le poser d'un seul côté
    // laisserait le cycle ouvert.
    //
    // Fix L8 (audit du 28/08/2026) : la ré-incrémentation n'avait aucun
    // plafond. Des cycles commande/annulation pouvaient gonfler `stockRestant`
    // au-delà de `stockQuotidien` — le vendeur se retrouvait à vendre plus que
    // ce qu'il avait déclaré, jusqu'au reset de 5 h. On borne au stock
    // déclaré ; `LEAST` ignore le cas `stockQuotidien IS NULL` grâce au
    // COALESCE.
    for (const id of [...qtyByProduct.keys()].sort()) {
      const qty = qtyByProduct.get(id)!;
      await tx.$executeRaw`
        UPDATE "Product"
        SET "stockRestant" = LEAST(
              "stockRestant" + ${qty},
              COALESCE("stockQuotidien", "stockRestant" + ${qty})
            )
        WHERE id = ${id} AND "stockRestant" IS NOT NULL
      `;
    }
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
  }

  // ─── Où est passé `resetDailyStock` ? ────────────────────────────────────
  //
  // Supprimé (fix S-5, audit du 05/09/2026). Il ne s'agissait pas seulement de
  // code mort — il était **faux**, et d'une façon coûteuse.
  //
  // Son commentaire annonçait « appelé par le scheduler à minuit ». Aucun
  // appelant n'existait (grep exhaustif) : le vrai reset vit dans
  // `RestaurantScheduleService.handleDailyStockReset`, à 4 h UTC. Et surtout,
  // cette version-ci omettait `AND "stockMode" = 'DAILY'` : elle aurait
  // rechargé chaque nuit le stock **réel** des épiceries et des vendeurs de
  // boissons, c'est-à-dire fabriqué du stock qui n'existe pas.
  //
  // Un code mort qui contredit la règle en vigueur est pire qu'un code mort :
  // il a l'air d'être la référence. Le prochain qui aurait cherché « le reset
  // de stock » l'aurait trouvé ici, dans le service de stock, à l'endroit
  // exact où on l'attend.
  //
  // ⚠️ Le reset n'a **qu'une** implémentation, et elle est dans
  // `modules/schedule/restaurant-schedule.service.ts`.
}
