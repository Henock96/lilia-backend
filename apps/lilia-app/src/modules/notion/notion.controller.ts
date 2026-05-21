import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { DocsBootstrapService } from './docs/docs-bootstrap.service';
import { TriggerBackfillDto } from './dto/trigger-sync.dto';
import { NotionBootstrapService } from './notion-bootstrap.service';
import { NotionHealthService } from './notion-health.service';
import { NotionService } from './notion.service';

/**
 * Endpoints d'administration du module Notion.
 * Tous restreints à ADMIN — utiles pour le bootstrap initial, les re-syncs
 * manuels et le monitoring opérationnel.
 */
@Roles('ADMIN')
@Controller('notion')
export class NotionController {
  constructor(
    private readonly notion: NotionService,
    private readonly bootstrap: NotionBootstrapService,
    private readonly docsBootstrap: DocsBootstrapService,
    private readonly health: NotionHealthService,
  ) {}

  @Get('health')
  async healthcheck() {
    return this.health.check();
  }

  @Get('queue/stats')
  async queueStats() {
    return this.notion.getQueueStats();
  }

  @Post('bootstrap')
  @HttpCode(200)
  async runBootstrap() {
    const result = await this.bootstrap.run();
    return {
      message:
        'Bootstrap terminé. Copie les IDs dans tes env vars pour persister.',
      data: result,
    };
  }

  @Post('docs/bootstrap')
  @HttpCode(200)
  async runDocsBootstrap() {
    const result = await this.docsBootstrap.run();
    return {
      message:
        'Docs bootstrap terminé. Structure wiki déployée sous la page racine.',
      data: result,
    };
  }

  @Post('sync/order/:id')
  @HttpCode(202)
  async resyncOrder(@Param('id') id: string) {
    await this.notion.enqueueOrderSync({ orderId: id, reason: 'manual' });
    return { message: 'Job enqueued', data: { orderId: id } };
  }

  @Post('sync/restaurant/:id')
  @HttpCode(202)
  async resyncRestaurant(@Param('id') id: string) {
    await this.notion.enqueueRestaurantSync({
      restaurantId: id,
      reason: 'manual',
    });
    return { message: 'Job enqueued', data: { restaurantId: id } };
  }

  @Post('sync/incident/:id')
  @HttpCode(202)
  async resyncIncident(@Param('id') id: string) {
    await this.notion.enqueueIncidentSync({
      incidentId: id,
      reason: 'manual',
    });
    return { message: 'Job enqueued', data: { incidentId: id } };
  }

  @Post('backfill')
  @HttpCode(202)
  async backfill(@Body() dto: TriggerBackfillDto) {
    await this.notion.enqueueBackfill(dto.entity, { limit: dto.limit });
    return { message: 'Backfill enqueued', data: dto };
  }
}
