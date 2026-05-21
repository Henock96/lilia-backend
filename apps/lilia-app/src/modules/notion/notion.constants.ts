/**
 * Constantes du module Notion.
 * Centralise les noms de queues, jobs, properties pour éviter les magic strings.
 */

export const NOTION_QUEUE = 'notion-sync';

export const NOTION_JOBS = {
  SYNC_ORDER: 'sync.order',
  SYNC_RESTAURANT: 'sync.restaurant',
  SYNC_INCIDENT: 'sync.incident',
  BACKFILL_ORDERS: 'backfill.orders',
  BACKFILL_RESTAURANTS: 'backfill.restaurants',
  BACKFILL_INCIDENTS: 'backfill.incidents',
} as const;

export type NotionJobName = (typeof NOTION_JOBS)[keyof typeof NOTION_JOBS];

/**
 * Property names Notion — utilisés à la fois par le bootstrap (qui crée la DB
 * avec ce schema) et les mappers (qui poussent les valeurs).
 * Garder synchronisé avec `notion-bootstrap.service.ts`.
 */
export const NOTION_PROPS = {
  ORDERS: {
    TITLE: 'Order',           // title — format "#ABC123"
    PRISMA_ID: 'Prisma ID',   // rich_text — clé d'idempotence
    STATUS: 'Status',         // select
    PAYMENT_METHOD: 'Payment method', // select
    TOTAL: 'Total (XAF)',     // number
    SERVICE_FEE: 'Service fee (XAF)',
    DELIVERY_FEE: 'Delivery fee (XAF)',
    DISCOUNT: 'Discount (XAF)',
    SUB_TOTAL: 'Sub-total (XAF)',
    RESTAURANT: 'Restaurant', // rich_text (nom)
    CUSTOMER: 'Customer',     // rich_text
    PHONE: 'Phone',           // phone_number
    ITEM_COUNT: 'Items',      // number
    CREATED_AT: 'Created at', // date
    PAID_AT: 'Paid at',       // date
  },
  RESTAURANTS: {
    TITLE: 'Restaurant',
    PRISMA_ID: 'Prisma ID',
    OWNER: 'Owner',
    IS_OPEN: 'Open',          // checkbox
    IS_ACTIVE: 'Active',
    AVERAGE_RATING: 'Rating',
    TOTAL_REVIEWS: 'Reviews',
    MIN_ORDER: 'Min order (XAF)',
    DELIVERY_FEE: 'Delivery fee (XAF)',
    ETA_MIN: 'ETA min',
    ETA_MAX: 'ETA max',
    PHONE: 'Phone',
    CREATED_AT: 'Onboarded at',
  },
  INCIDENTS: {
    TITLE: 'Incident',
    PRISMA_ID: 'Prisma ID',
    TYPE: 'Type',
    SEVERITY: 'Severity',
    STATUS: 'Status',
    ORDER_ID: 'Order ID',
    RIDER_ID: 'Rider ID',
    RESTAURANT_ID: 'Restaurant ID',
    DESCRIPTION: 'Description',
    RESOLUTION: 'Resolution',
    CREATED_AT: 'Created at',
    RESOLVED_AT: 'Resolved at',
  },
} as const;

/** Notion API rate limit : ~3 requêtes/seconde par integration. */
export const NOTION_RATE_LIMIT_PER_SECOND = 3;
