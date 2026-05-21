import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { NotionClient } from './notion.client';
import { NotionConfig } from './notion.config';
import { NOTION_PROPS } from './notion.constants';

/**
 * Crée la structure Notion au démarrage si elle n'existe pas encore.
 *
 * Logique :
 *   1. Si NOTION_ROOT_PAGE_ID est fourni → on l'utilise tel quel.
 *   2. Sinon, si NOTION_WORKSPACE_PAGE_ID est fourni → on crée une page
 *      "LILIA FOOD OPERATIONS" sous ce parent.
 *   3. Sinon → on log un warning et on n'initialise rien.
 *
 * Pour chaque database (orders, restaurants, incidents) :
 *   - Si l'ID est fourni en env → on l'utilise.
 *   - Sinon → on crée la database sous la page racine, et on stocke l'ID
 *     en mémoire (NotionConfig.setDbId).
 *
 * Le bootstrap NE persiste PAS les IDs créés — au prochain restart, l'admin
 * doit copier les IDs depuis les logs et les mettre en env vars
 * (NOTION_DB_ORDERS, NOTION_DB_RESTAURANTS, NOTION_DB_INCIDENTS).
 */
@Injectable()
export class NotionBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotionBootstrapService.name);

  constructor(
    private readonly notion: NotionClient,
    private readonly notionConfig: NotionConfig,
  ) {}

  async onApplicationBootstrap() {
    if (!this.notionConfig.isEnabled) {
      this.logger.warn(
        'Notion désactivé (NOTION_TOKEN absent) — bootstrap ignoré',
      );
      return;
    }

    try {
      await this.run();
    } catch (e) {
      this.logger.error(
        `Bootstrap Notion échoué — la sync sera désactivée jusqu'à correction: ${(e as Error).message}`,
      );
    }
  }

  /** Appelable manuellement via le controller POST /notion/bootstrap. */
  async run(): Promise<{
    rootPageId: string;
    orders: string;
    restaurants: string;
    incidents: string;
  }> {
    const rootPageId = await this.ensureRootPage();

    const orders =
      this.notionConfig.getDbId('orders') ??
      (await this.createOrdersDb(rootPageId));
    const restaurants =
      this.notionConfig.getDbId('restaurants') ??
      (await this.createRestaurantsDb(rootPageId));
    const incidents =
      this.notionConfig.getDbId('incidents') ??
      (await this.createIncidentsDb(rootPageId));

    this.notionConfig.setDbId('orders', orders);
    this.notionConfig.setDbId('restaurants', restaurants);
    this.notionConfig.setDbId('incidents', incidents);

    this.logger.log(
      `Notion bootstrap OK. Pour persister, mets en env :\n` +
        `  NOTION_ROOT_PAGE_ID=${rootPageId}\n` +
        `  NOTION_DB_ORDERS=${orders}\n` +
        `  NOTION_DB_RESTAURANTS=${restaurants}\n` +
        `  NOTION_DB_INCIDENTS=${incidents}`,
    );

    return { rootPageId, orders, restaurants, incidents };
  }

  private async ensureRootPage(): Promise<string> {
    const existing = this.notionConfig.rootPageId;
    if (existing) return existing;

    const workspaceParent = this.notionConfig.workspacePageId;
    if (!workspaceParent) {
      throw new Error(
        'Aucun parent — fournir NOTION_ROOT_PAGE_ID OU NOTION_WORKSPACE_PAGE_ID ' +
          '(page Notion partagée avec l\'integration).',
      );
    }

    const page = await this.notion.exec('createRootPage', (c) =>
      c.pages.create({
        parent: { page_id: workspaceParent },
        properties: {
          title: { title: [{ text: { content: 'LILIA FOOD OPERATIONS' } }] },
        },
        icon: { type: 'emoji', emoji: '🍱' },
      }),
    );
    this.logger.log(`Page racine créée: ${page.id}`);
    return page.id;
  }

  /**
   * Crée une database et retourne l'ID du data source initial (Notion SDK v5+).
   * Le data_source_id est celui qu'on utilise pour query + create page.
   */
  private async createDb(
    parentPageId: string,
    title: string,
    icon: string,
    properties: Record<string, unknown>,
  ): Promise<string> {
    const db = await this.notion.exec(`createDb(${title})`, (c) =>
      c.databases.create({
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: title } }],
        icon: { type: 'emoji', emoji: icon as any },
        initial_data_source: { properties: properties as any },
      } as any),
    );

    const dataSources = (db as { data_sources?: Array<{ id: string }> })
      .data_sources;
    const dataSourceId = dataSources?.[0]?.id;
    if (!dataSourceId) {
      throw new Error(
        `DB ${title} créée (${db.id}) mais pas de data_source_id retourné`,
      );
    }
    this.logger.log(`DB ${title} → ${db.id} / data_source ${dataSourceId}`);
    return dataSourceId;
  }

  private createOrdersDb(parentPageId: string): Promise<string> {
    const P = NOTION_PROPS.ORDERS;
    return this.createDb(parentPageId, 'Orders', '🧾', {
      [P.TITLE]: { title: {} },
      [P.PRISMA_ID]: { rich_text: {} },
      [P.STATUS]: {
        select: {
          options: [
            { name: 'EN_ATTENTE', color: 'gray' },
            { name: 'PAYER', color: 'blue' },
            { name: 'EN_PREPARATION', color: 'yellow' },
            { name: 'PRET', color: 'green' },
            { name: 'EN_ROUTE', color: 'purple' },
            { name: 'LIVRER', color: 'green' },
            { name: 'ANNULER', color: 'red' },
          ],
        },
      },
      [P.PAYMENT_METHOD]: {
        select: {
          options: [
            { name: 'MTN_MOMO', color: 'yellow' },
            { name: 'AIRTEL_MONEY', color: 'red' },
          ],
        },
      },
      [P.TOTAL]: { number: { format: 'number' } },
      [P.SUB_TOTAL]: { number: { format: 'number' } },
      [P.SERVICE_FEE]: { number: { format: 'number' } },
      [P.DELIVERY_FEE]: { number: { format: 'number' } },
      [P.DISCOUNT]: { number: { format: 'number' } },
      [P.RESTAURANT]: { rich_text: {} },
      [P.CUSTOMER]: { rich_text: {} },
      [P.PHONE]: { phone_number: {} },
      [P.ITEM_COUNT]: { number: { format: 'number' } },
      [P.CREATED_AT]: { date: {} },
      [P.PAID_AT]: { date: {} },
    });
  }

  private createRestaurantsDb(parentPageId: string): Promise<string> {
    const P = NOTION_PROPS.RESTAURANTS;
    return this.createDb(parentPageId, 'Restaurants', '🏪', {
      [P.TITLE]: { title: {} },
      [P.PRISMA_ID]: { rich_text: {} },
      [P.OWNER]: { rich_text: {} },
      [P.IS_OPEN]: { checkbox: {} },
      [P.IS_ACTIVE]: { checkbox: {} },
      [P.AVERAGE_RATING]: { number: { format: 'number' } },
      [P.TOTAL_REVIEWS]: { number: { format: 'number' } },
      [P.MIN_ORDER]: { number: { format: 'number' } },
      [P.DELIVERY_FEE]: { number: { format: 'number' } },
      [P.ETA_MIN]: { number: { format: 'number' } },
      [P.ETA_MAX]: { number: { format: 'number' } },
      [P.PHONE]: { phone_number: {} },
      [P.CREATED_AT]: { date: {} },
    });
  }

  private createIncidentsDb(parentPageId: string): Promise<string> {
    const P = NOTION_PROPS.INCIDENTS;
    return this.createDb(parentPageId, 'Incidents', '🚨', {
      [P.TITLE]: { title: {} },
      [P.PRISMA_ID]: { rich_text: {} },
      [P.TYPE]: {
        select: {
          options: [
            { name: 'ORDER_CANCELLED', color: 'red' },
            { name: 'ORDER_DELAYED', color: 'orange' },
            { name: 'PAYMENT_FAILED', color: 'pink' },
            { name: 'DRIVER_NO_SHOW', color: 'red' },
            { name: 'DRIVER_ACCIDENT', color: 'red' },
            { name: 'CUSTOMER_COMPLAINT', color: 'yellow' },
            { name: 'RESTAURANT_CLOSED', color: 'gray' },
            { name: 'STOCK_ISSUE', color: 'orange' },
            { name: 'WRONG_DELIVERY', color: 'red' },
            { name: 'REFUND_REQUEST', color: 'purple' },
            { name: 'OTHER', color: 'default' },
          ],
        },
      },
      [P.SEVERITY]: {
        select: {
          options: [
            { name: 'LOW', color: 'blue' },
            { name: 'MEDIUM', color: 'yellow' },
            { name: 'HIGH', color: 'orange' },
            { name: 'CRITICAL', color: 'red' },
          ],
        },
      },
      [P.STATUS]: {
        select: {
          options: [
            { name: 'OPEN', color: 'red' },
            { name: 'IN_PROGRESS', color: 'yellow' },
            { name: 'RESOLVED', color: 'green' },
            { name: 'CLOSED', color: 'gray' },
          ],
        },
      },
      [P.ORDER_ID]: { rich_text: {} },
      [P.RIDER_ID]: { rich_text: {} },
      [P.RESTAURANT_ID]: { rich_text: {} },
      [P.DESCRIPTION]: { rich_text: {} },
      [P.RESOLUTION]: { rich_text: {} },
      [P.CREATED_AT]: { date: {} },
      [P.RESOLVED_AT]: { date: {} },
    });
  }
}
