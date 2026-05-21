import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { mapIncidentToNotion } from '../mappers/incident.mapper';
import { NotionClient } from '../notion.client';
import { NotionConfig } from '../notion.config';
import { NOTION_PROPS } from '../notion.constants';

@Injectable()
export class IncidentsSyncService {
  private readonly logger = new Logger(IncidentsSyncService.name);

  constructor(
    private readonly notion: NotionClient,
    private readonly notionConfig: NotionConfig,
    private readonly prisma: PrismaService,
  ) {}

  async syncOne(incidentId: string): Promise<void> {
    const dbId = this.notionConfig.getDbId('incidents');
    if (!dbId) {
      this.logger.warn(
        'NOTION_DB_INCIDENTS absent — bootstrap requis avant sync',
      );
      return;
    }

    const incident = await this.prisma.incident.findUnique({
      where: { id: incidentId },
    });
    if (!incident) {
      this.logger.warn(`Incident ${incidentId} introuvable — skip sync Notion`);
      return;
    }

    const properties = mapIncidentToNotion(incident);
    const existing = await this.notion.findPageByPrismaId(
      dbId,
      NOTION_PROPS.INCIDENTS.PRISMA_ID,
      incident.id,
    );

    if (existing) {
      await this.notion.exec(`updateIncident(${incident.id})`, (c) =>
        c.pages.update({ page_id: existing, properties: properties as any }),
      );
      this.logger.log(`Notion incident updated: ${incident.id}`);
    } else {
      await this.notion.exec(`createIncident(${incident.id})`, (c) =>
        c.pages.create({
          parent: { data_source_id: dbId },
          properties: properties as any,
        }),
      );
      this.logger.log(`Notion incident created: ${incident.id}`);
    }
  }

  async backfill(limit = 100, cursor?: string): Promise<{ next?: string }> {
    const incidents = await this.prisma.incident.findMany({
      take: limit,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    for (const i of incidents) {
      try {
        await this.syncOne(i.id);
      } catch (e) {
        this.logger.error(
          `Backfill incident ${i.id} échec: ${(e as Error).message}`,
        );
      }
    }

    return {
      next:
        incidents.length === limit
          ? incidents[incidents.length - 1].id
          : undefined,
    };
  }
}
