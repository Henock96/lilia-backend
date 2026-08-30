import { Module } from '@nestjs/common';
import { MenusService } from './menus.service';
import { MenuQueryService } from './menu-query.service';
import { MenuCommandService } from './menu-command.service';
import { MenuLifecycleService } from './menu-lifecycle.service';
import { MenusController } from './menus.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';

@Module({
  // `RestaurantsModule` fournit `RestaurantAccessService`, qui arbitre le
  // vendeur cible d'une écriture au catalogue (le sien, ou celui qu'un ADMIN
  // désigne explicitement).
  imports: [PrismaModule, RestaurantsModule],
  controllers: [MenusController],
  providers: [
    MenusService,
    MenuQueryService,
    MenuCommandService,
    MenuLifecycleService,
  ],
})
export class MenusModule {}
