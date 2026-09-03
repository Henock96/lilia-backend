import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategoriesController } from './categories.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/**
 * ⚠️ `CategoriesCoreModule` (sans controller) est le module à importer depuis un
 * autre module — notamment `VendorsModule`, qui crée les sections par défaut à
 * la naissance d'un vendeur. Importer `CategoriesModule` y entraînerait
 * `CategoriesController` dans le graphe de tout consommateur, y compris le
 * worker : c'est exactement le défaut corrigé en août 2026 (routes admin
 * montées sur le port du worker, sans authentification).
 */
@Module({
  imports: [PrismaModule, RestaurantsModule, AdminAuditModule],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesCoreModule {}

@Module({
  imports: [CategoriesCoreModule],
  controllers: [CategoriesController],
  exports: [CategoriesCoreModule],
})
export class CategoriesModule {}
