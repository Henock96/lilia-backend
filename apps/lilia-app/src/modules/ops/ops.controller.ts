import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { OpsQueueService } from './ops-queue.service';

/**
 * Cockpit ops « À traiter » (F3-04) — ADMIN.
 *
 * Lecture seule : chaque carte renvoie vers l'écran qui porte déjà l'action
 * (commande, remboursement, reversement, incident). Le cockpit ne duplique
 * aucun geste, il dit lequel faire.
 */
@ApiTags('Ops')
@ApiBearerAuth()
@Controller('admin/ops')
@Roles('ADMIN')
export class OpsController {
  constructor(private readonly queue: OpsQueueService) {}

  @Get('queue')
  @ApiOperation({ summary: 'Files « À traiter », les plus anciennes d’abord' })
  async getQueue() {
    const buckets = await this.queue.queue();
    return {
      data: {
        generatedAt: new Date().toISOString(),
        total: buckets.reduce((sum, b) => sum + b.count, 0),
        buckets,
      },
    };
  }
}
