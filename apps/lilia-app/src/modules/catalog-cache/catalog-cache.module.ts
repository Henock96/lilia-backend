import { Global, Module } from '@nestjs/common';

import { CatalogCacheListener } from './catalog-cache.listener';
import { CatalogRevalidationService } from './catalog-revalidation.service';

/**
 * Invalidation du cache du site public après une écriture au catalogue.
 *
 * **Aucun controller** — ce module n'expose rien, il écoute. Il peut donc être
 * importé par le worker sans y monter de route (cf. la règle des modules
 * `*-core` dans `CLAUDE.local.md`).
 *
 * `@Global` parce que l'émission se fait par `EventEmitter2`, qui est lui-même
 * global : les services d'écriture n'importent rien de ce module, ils publient
 * un événement. Rien à câbler ailleurs qu'ici.
 */
@Global()
@Module({
  providers: [CatalogRevalidationService, CatalogCacheListener],
  exports: [CatalogRevalidationService],
})
export class CatalogCacheModule {}
