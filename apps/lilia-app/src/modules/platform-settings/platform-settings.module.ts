import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformSettingsController } from './platform-settings.controller';
import { MaintenanceGuard } from './guards/maintenance.guard';

@Module({
  imports: [PrismaModule],
  controllers: [PlatformSettingsController],
  providers: [PlatformSettingsService, MaintenanceGuard],
  exports: [PlatformSettingsService, MaintenanceGuard],
})
export class PlatformSettingsModule {}
