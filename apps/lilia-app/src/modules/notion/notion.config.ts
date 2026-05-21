import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface NotionDatabaseIds {
  orders?: string;
  restaurants?: string;
  incidents?: string;
}

/**
 * Wrapper config pour le module Notion.
 * Les IDs de databases sont mutables — initialisés au bootstrap si absents
 * de la config, puis utilisés en mémoire par le runtime.
 */
@Injectable()
export class NotionConfig {
  private readonly logger = new Logger(NotionConfig.name);
  private dbIds: NotionDatabaseIds = {};

  constructor(private readonly config: ConfigService) {
    this.dbIds = {
      orders: config.get<string>('NOTION_DB_ORDERS'),
      restaurants: config.get<string>('NOTION_DB_RESTAURANTS'),
      incidents: config.get<string>('NOTION_DB_INCIDENTS'),
    };
  }

  get token(): string {
    const token = this.config.get<string>('NOTION_TOKEN');
    if (!token) {
      throw new Error(
        'NOTION_TOKEN manquant — créer une integration sur notion.so/my-integrations',
      );
    }
    return token;
  }

  /** Page parent sous laquelle créer la structure. Peut être vide → bootstrap créera la racine. */
  get rootPageId(): string | undefined {
    return this.config.get<string>('NOTION_ROOT_PAGE_ID');
  }

  /** Page workspace partagée avec l'integration — sert de parent au bootstrap. */
  get workspacePageId(): string | undefined {
    return this.config.get<string>('NOTION_WORKSPACE_PAGE_ID');
  }

  get isEnabled(): boolean {
    return !!this.config.get<string>('NOTION_TOKEN');
  }

  getDbId(entity: keyof NotionDatabaseIds): string | undefined {
    return this.dbIds[entity];
  }

  setDbId(entity: keyof NotionDatabaseIds, id: string) {
    this.dbIds[entity] = id;
    this.logger.log(`Notion DB id mémorisé en runtime: ${entity} → ${id}`);
  }

  getAllDbIds(): NotionDatabaseIds {
    return { ...this.dbIds };
  }
}
