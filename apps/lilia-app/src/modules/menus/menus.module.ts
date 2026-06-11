import { Module } from '@nestjs/common';
import { MenusService } from './menus.service';
import { MenuQueryService } from './menu-query.service';
import { MenuCommandService } from './menu-command.service';
import { MenuLifecycleService } from './menu-lifecycle.service';
import { MenusController } from './menus.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [MenusController],
  providers: [
    MenusService,
    MenuQueryService,
    MenuCommandService,
    MenuLifecycleService,
  ],
})
export class MenusModule {}
