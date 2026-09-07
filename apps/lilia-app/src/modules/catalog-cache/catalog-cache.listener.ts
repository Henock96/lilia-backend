import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { CATALOG_CHANGED, CatalogChangedEvent } from '../events/catalog-events';
import { CatalogRevalidationService } from './catalog-revalidation.service';

/**
 * Seul consommateur de `catalog.changed`.
 *
 * Il existe pour que les services d'écriture ne connaissent pas le site public :
 * `ProductCommandService` émet « la carte de ce vendeur a changé » et s'arrête
 * là. Brancher l'appel HTTP directement dans les services aurait mis une
 * dépendance réseau au milieu de dix-huit chemins d'écriture, et un jour l'un
 * d'eux l'aurait attendue.
 */
@Injectable()
export class CatalogCacheListener {
  constructor(private readonly revalidation: CatalogRevalidationService) {}

  @OnEvent(CATALOG_CHANGED)
  handleCatalogChanged(event: CatalogChangedEvent): void {
    this.revalidation.revalidateVendor(event.restaurantId, event.reason);
  }
}
