import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  mapRestaurantToNotion,
  RestaurantWithOwner,
} from '../mappers/restaurant.mapper';
import { NotionClient } from '../notion.client';
import { NotionConfig } from '../notion.config';
import { NOTION_PROPS } from '../notion.constants';

@Injectable()
export class RestaurantsSyncService {
  private readonly logger = new Logger(RestaurantsSyncService.name);

  constructor(
    private readonly notion: NotionClient,
    private readonly notionConfig: NotionConfig,
    private readonly prisma: PrismaService,
  ) {}

  async syncOne(restaurantId: string): Promise<void> {
    const dbId = this.notionConfig.getDbId('restaurants');
    if (!dbId) {
      this.logger.warn(
        'NOTION_DB_RESTAURANTS absent — bootstrap requis avant sync',
      );
      return;
    }

    const resto = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        owner: { select: { nom: true, email: true, phone: true } },
      },
    });

    if (!resto) {
      this.logger.warn(
        `Restaurant ${restaurantId} introuvable — skip sync Notion`,
      );
      return;
    }

    const ratingAgg = await this.prisma.review.aggregate({
      where: { restaurantId },
      _avg: { rating: true },
      _count: { _all: true },
    });

    const properties = mapRestaurantToNotion({
      ...resto,
      averageRating: ratingAgg._avg.rating ?? 0,
      totalReviews: ratingAgg._count._all,
    } as RestaurantWithOwner);

    const existing = await this.notion.findPageByPrismaId(
      dbId,
      NOTION_PROPS.RESTAURANTS.PRISMA_ID,
      resto.id,
    );

    if (existing) {
      await this.notion.exec(`updateRestaurant(${resto.id})`, (c) =>
        c.pages.update({ page_id: existing, properties: properties as any }),
      );
      this.logger.log(`Notion restaurant updated: ${resto.id}`);
    } else {
      await this.notion.exec(`createRestaurant(${resto.id})`, (c) =>
        c.pages.create({
          parent: { data_source_id: dbId },
          properties: properties as any,
        }),
      );
      this.logger.log(`Notion restaurant created: ${resto.id}`);
    }
  }

  async backfill(limit = 100, cursor?: string): Promise<{ next?: string }> {
    const restos = await this.prisma.restaurant.findMany({
      take: limit,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    for (const r of restos) {
      try {
        await this.syncOne(r.id);
      } catch (e) {
        this.logger.error(
          `Backfill restaurant ${r.id} échec: ${(e as Error).message}`,
        );
      }
    }

    return {
      next: restos.length === limit ? restos[restos.length - 1].id : undefined,
    };
  }
}
