import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { DocsBootstrapService } from './docs/docs-bootstrap.service';
import { NotionListener } from './listeners/notion.listener';
import { NotionBootstrapService } from './notion-bootstrap.service';
import { NotionClient } from './notion.client';
import { NotionConfig } from './notion.config';
import { NotionController } from './notion.controller';
import { NotionHealthService } from './notion-health.service';
import { NotionService } from './notion.service';
import { NOTION_QUEUE } from './notion.constants';
import { NotionSyncProcessor } from './processors/notion-sync.processor';
import { IncidentsSyncService } from './sync/incidents-sync.service';
import { OrdersSyncService } from './sync/orders-sync.service';
import { RestaurantsSyncService } from './sync/restaurants-sync.service';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        if (!url) {
          // BullMQ requiert Redis — sans REDIS_URL, on log mais on laisse échouer
          // explicitement plutôt que de masquer un misconfig.
          // eslint-disable-next-line no-console
          console.warn(
            '[NotionModule] REDIS_URL absent — BullMQ ne pourra pas se connecter',
          );
        }
        const u = new URL(url ?? 'redis://localhost:6379');
        return {
          connection: {
            host: u.hostname,
            port: parseInt(u.port || '6379', 10),
            ...(u.password && { password: u.password }),
            ...(u.username && { username: u.username }),
            ...(u.protocol === 'rediss:' && { tls: {} }),
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: NOTION_QUEUE }),
  ],
  controllers: [NotionController],
  providers: [
    NotionConfig,
    NotionClient,
    NotionService,
    NotionBootstrapService,
    NotionHealthService,
    DocsBootstrapService,
    OrdersSyncService,
    RestaurantsSyncService,
    IncidentsSyncService,
    NotionSyncProcessor,
    NotionListener,
  ],
  exports: [NotionService],
})
export class NotionModule {}
