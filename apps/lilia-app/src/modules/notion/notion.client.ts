import { APIErrorCode, Client } from '@notionhq/client';
import { Injectable, Logger } from '@nestjs/common';
import { NotionConfig } from './notion.config';
import { NOTION_RATE_LIMIT_PER_SECOND } from './notion.constants';

/**
 * Wrapper bas niveau autour de @notionhq/client.
 *
 * Apporte 3 garanties :
 *   1. Retry exponentiel sur erreurs transitoires (429, 5xx, conflict)
 *   2. Rate limiting client-side (~3 req/s — limite Notion par integration)
 *   3. Logger structuré pour debug
 *
 * Les services métier (mappers, sync) appellent ce client, jamais @notionhq/client directement.
 */
@Injectable()
export class NotionClient {
  private readonly logger = new Logger(NotionClient.name);
  private client?: Client;
  private lastRequestAt = 0;

  constructor(private readonly notionConfig: NotionConfig) {}

  private getClient(): Client {
    if (!this.client) {
      this.client = new Client({
        auth: this.notionConfig.token,
        notionVersion: '2022-06-28',
      });
    }
    return this.client;
  }

  /** Throttle minimal pour respecter ~3 req/s. */
  private async throttle(): Promise<void> {
    const minIntervalMs = Math.ceil(1000 / NOTION_RATE_LIMIT_PER_SECOND);
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < minIntervalMs) {
      await this.sleep(minIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }

  /**
   * Exécute une requête Notion avec retry exponentiel (3 tentatives max).
   * Backoff : 500ms, 1500ms, 4500ms.
   */
  async exec<T>(
    label: string,
    fn: (client: Client) => Promise<T>,
    maxAttempts = 3,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.throttle();
        return await fn(this.getClient());
      } catch (error) {
        lastError = error;
        if (!this.isRetryable(error) || attempt === maxAttempts) {
          this.logger.error(
            `Notion ${label} échec définitif (tentative ${attempt}/${maxAttempts}): ${this.formatError(error)}`,
          );
          throw error;
        }
        const backoffMs = 500 * Math.pow(3, attempt - 1);
        this.logger.warn(
          `Notion ${label} retry ${attempt}/${maxAttempts} dans ${backoffMs}ms — ${this.formatError(error)}`,
        );
        await this.sleep(backoffMs);
      }
    }
    throw lastError;
  }

  private isRetryable(error: unknown): boolean {
    const code = (error as { code?: string })?.code;
    if (!code) return false;
    return (
      code === APIErrorCode.RateLimited ||
      code === APIErrorCode.InternalServerError ||
      code === APIErrorCode.ServiceUnavailable ||
      code === APIErrorCode.ConflictError
    );
  }

  private formatError(error: unknown): string {
    const e = error as { code?: string; message?: string; status?: number };
    return `[${e.code ?? 'unknown'}${e.status ? ' ' + e.status : ''}] ${e.message ?? 'no message'}`;
  }

  /**
   * Recherche une page existante via sa Prisma ID (idempotence).
   * Notion SDK v5+ : les queries passent par `dataSources`, pas `databases`.
   * Retourne le page ID si trouvé, null sinon.
   */
  async findPageByPrismaId(
    dataSourceId: string,
    prismaIdProperty: string,
    prismaId: string,
  ): Promise<string | null> {
    const result = await this.exec(`findPageByPrismaId(${prismaId})`, (c) =>
      c.dataSources.query({
        data_source_id: dataSourceId,
        filter: {
          property: prismaIdProperty,
          rich_text: { equals: prismaId },
        },
        page_size: 1,
      }),
    );
    const first = (result as { results: Array<{ id: string }> }).results[0];
    return first?.id ?? null;
  }

  raw(): Client {
    return this.getClient();
  }
}
