import { Injectable, Logger } from '@nestjs/common';
import { NotionClient } from '../notion.client';
import { NotionConfig } from '../notion.config';
import {
  chunkBlocks,
  MAX_CHILDREN_PER_REQUEST,
  NotionBlock,
} from './docs-block.helpers';
import { PageDef } from './page-def.types';
import { buildTechDocsSection } from './sections/tech-docs.builder';
import { buildBackendModulesSection } from './sections/backend-modules.builder';
import { buildClientAppSection } from './sections/client-app.builder';
import { buildRiderAppSection } from './sections/rider-app.builder';
import { buildRestaurantsSection } from './sections/restaurants.builder';
import { buildOperationsSection } from './sections/operations.builder';
import { buildCeoDashboardSection } from './sections/ceo-dashboard.builder';
import { buildRoadmapSection } from './sections/roadmap.builder';

export interface DocsBootstrapResult {
  rootPageId: string;
  sectionsCreated: number;
  pagesCreated: number;
  pagesSkipped: number;
}

@Injectable()
export class DocsBootstrapService {
  private readonly logger = new Logger(DocsBootstrapService.name);
  private created = 0;
  private skipped = 0;

  constructor(
    private readonly notion: NotionClient,
    private readonly notionConfig: NotionConfig,
  ) {}

  /**
   * Génère la structure wiki sous la page racine.
   * Idempotent : ré-exécutable sans dupliquer les pages.
   */
  async run(): Promise<DocsBootstrapResult> {
    const rootPageId = this.notionConfig.rootPageId;
    if (!rootPageId) {
      throw new Error(
        'NOTION_ROOT_PAGE_ID absent — lance POST /notion/bootstrap avant les docs.',
      );
    }

    this.created = 0;
    this.skipped = 0;

    const sections: PageDef[] = [
      buildTechDocsSection(),
      buildBackendModulesSection(),
      buildClientAppSection(),
      buildRiderAppSection(),
      buildRestaurantsSection(),
      buildOperationsSection(),
      buildCeoDashboardSection(),
      buildRoadmapSection(),
    ];

    for (const section of sections) {
      await this.deployPage(rootPageId, section);
    }

    this.logger.log(
      `Docs bootstrap terminé. Créées: ${this.created}, skipped: ${this.skipped}, sections: ${sections.length}`,
    );

    return {
      rootPageId,
      sectionsCreated: sections.length,
      pagesCreated: this.created,
      pagesSkipped: this.skipped,
    };
  }

  /** Récursif : crée la page (ou la skip si existante), puis ses sous-pages. */
  private async deployPage(parentId: string, def: PageDef): Promise<string> {
    const existingId = await this.findChildPageByTitle(parentId, def.title);
    let pageId: string;

    if (existingId) {
      this.skipped++;
      this.logger.log(`Page existante: "${def.title}" (${existingId}) — skip contenu`);
      pageId = existingId;
    } else {
      pageId = await this.createPage(parentId, def);
      await this.appendChunked(pageId, def.children);
      this.created++;
      this.logger.log(`Page créée: "${def.title}" → ${pageId}`);
    }

    if (def.subPages?.length) {
      for (const sub of def.subPages) {
        await this.deployPage(pageId, sub);
      }
    }

    return pageId;
  }

  private async createPage(
    parentId: string,
    def: Pick<PageDef, 'title' | 'icon'>,
  ): Promise<string> {
    const page = await this.notion.exec(`createDocsPage(${def.title})`, (c) =>
      c.pages.create({
        parent: { page_id: parentId },
        properties: {
          title: { title: [{ text: { content: def.title } }] },
        },
        ...(def.icon && { icon: { type: 'emoji', emoji: def.icon as any } }),
      } as any),
    );
    return page.id;
  }

  private async appendChunked(
    pageId: string,
    blocks: NotionBlock[],
  ): Promise<void> {
    if (!blocks.length) return;
    const chunks = chunkBlocks(blocks);
    for (const chunk of chunks) {
      await this.notion.exec(
        `appendBlocks(${pageId}, ${chunk.length})`,
        (c) =>
          c.blocks.children.append({
            block_id: pageId,
            children: chunk as any,
          }),
      );
    }
  }

  /**
   * Liste les child blocks d'une page et cherche un child_page avec le titre donné.
   * Paginé jusqu'à épuisement.
   */
  private async findChildPageByTitle(
    parentId: string,
    title: string,
  ): Promise<string | null> {
    let cursor: string | undefined = undefined;
    do {
      const res = await this.notion.exec(`listChildren(${parentId})`, (c) =>
        c.blocks.children.list({
          block_id: parentId,
          page_size: MAX_CHILDREN_PER_REQUEST,
          ...(cursor && { start_cursor: cursor }),
        }),
      );

      const results = (res as {
        results: Array<{ id: string; type?: string; child_page?: { title: string } }>;
        has_more?: boolean;
        next_cursor?: string | null;
      });

      for (const block of results.results) {
        if (block.type === 'child_page' && block.child_page?.title === title) {
          return block.id;
        }
      }

      cursor =
        results.has_more && results.next_cursor
          ? results.next_cursor
          : undefined;
    } while (cursor);

    return null;
  }
}
