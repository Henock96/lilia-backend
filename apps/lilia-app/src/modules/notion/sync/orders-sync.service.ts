import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  mapOrderToNotion,
  OrderWithRelations,
} from '../mappers/order.mapper';
import { NotionClient } from '../notion.client';
import { NotionConfig } from '../notion.config';
import { NOTION_PROPS } from '../notion.constants';

@Injectable()
export class OrdersSyncService {
  private readonly logger = new Logger(OrdersSyncService.name);

  constructor(
    private readonly notion: NotionClient,
    private readonly notionConfig: NotionConfig,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Upsert d'une commande dans la database Notion correspondante.
   * Idempotent : si une page existe déjà avec le même Prisma ID, on update.
   */
  async syncOne(orderId: string): Promise<void> {
    const dbId = this.notionConfig.getDbId('orders');
    if (!dbId) {
      this.logger.warn('NOTION_DB_ORDERS absent — bootstrap requis avant sync');
      return;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        restaurant: { select: { nom: true } },
        user: { select: { nom: true, phone: true, email: true } },
      },
    });

    if (!order) {
      this.logger.warn(`Order ${orderId} introuvable — skip sync Notion`);
      return;
    }

    const properties = mapOrderToNotion(order as OrderWithRelations);
    const existing = await this.notion.findPageByPrismaId(
      dbId,
      NOTION_PROPS.ORDERS.PRISMA_ID,
      order.id,
    );

    if (existing) {
      await this.notion.exec(`updateOrder(${order.id})`, (c) =>
        c.pages.update({ page_id: existing, properties: properties as any }),
      );
      this.logger.log(`Notion order updated: ${order.id}`);
    } else {
      await this.notion.exec(`createOrder(${order.id})`, (c) =>
        c.pages.create({
          parent: { data_source_id: dbId },
          properties: properties as any,
        }),
      );
      this.logger.log(`Notion order created: ${order.id}`);
    }
  }

  /** Backfill paginé — utilisé par le job manuel POST /notion/sync/all. */
  async backfill(limit = 100, cursor?: string): Promise<{ next?: string }> {
    const orders = await this.prisma.order.findMany({
      take: limit,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    for (const o of orders) {
      try {
        await this.syncOne(o.id);
      } catch (e) {
        this.logger.error(
          `Backfill order ${o.id} échec: ${(e as Error).message}`,
        );
      }
    }

    return {
      next: orders.length === limit ? orders[orders.length - 1].id : undefined,
    };
  }
}
