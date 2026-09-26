import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import { CATALOG_CHANGED, CatalogChangedEvent } from '../events/catalog-events';
import type { StockMovement } from './stock.service';
import { variantStockVerdict } from './stock-units';

/**
 * F3-10 — prévient le cache du catalogue quand un **format** change de statut
 * à cause d'une vente ou d'une restitution.
 *
 * Avant F3-10, la décrémentation n'émettait jamais `CATALOG_CHANGED` : une
 * rupture restait affichée « disponible » sur le site pendant quelques
 * minutes (le serveur arbitrait quand même). Émettre à chaque vente serait
 * l'excès inverse : on n'émet que si le statut publié d'au moins un format
 * change (`AVAILABLE ↔ LOW ↔ OUT_OF_STOCK`). Un carton de 6 devient épuisé à
 * 5 bouteilles alors que la bouteille reste vendable : c'est ce statut-là que
 * le site affiche, c'est donc lui qui compte.
 *
 * Toujours **après commit** et sans jamais lever : un signal de cache ne doit
 * pas faire échouer une commande.
 */
@Injectable()
export class StockSignalService {
  private readonly logger = new Logger(StockSignalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async announce(
    movements: readonly StockMovement[],
    reason: string,
  ): Promise<void> {
    if (!movements?.length) return;
    try {
      const products = await this.prisma.product.findMany({
        where: { id: { in: movements.map((m) => m.productId) } },
        select: {
          id: true,
          restaurantId: true,
          variants: { select: { stockConsumption: true } },
        },
      });
      const byId = new Map(products.map((p) => [p.id, p]));
      const restaurants = new Set<string>();
      for (const movement of movements) {
        const product = byId.get(movement.productId);
        if (!product) continue;
        const changed = product.variants.some(
          (v) =>
            variantStockVerdict(movement.before, v.stockConsumption)
              .stockStatus !==
            variantStockVerdict(movement.after, v.stockConsumption).stockStatus,
        );
        if (changed) restaurants.add(product.restaurantId);
      }
      for (const restaurantId of restaurants) {
        this.eventEmitter.emit(
          CATALOG_CHANGED,
          new CatalogChangedEvent(restaurantId, `stock.${reason}`),
        );
      }
    } catch (error) {
      this.logger.warn(
        `[STOCK] signal catalogue non émis : ${(error as Error).message}`,
      );
    }
  }
}
