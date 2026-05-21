/* eslint-disable no-console */
/**
 * Bootstrap Notion — script CLI standalone.
 *
 * Usage:
 *   npx ts-node scripts/bootstrap-notion.ts
 *
 * Étapes:
 *   1. Vérifie le token Notion (users.me)
 *   2. Si NOTION_WORKSPACE_PAGE_ID absent → search() pour trouver la page partagée
 *   3. Crée la page racine "LILIA FOOD OPERATIONS"
 *   4. Crée les 3 databases (Orders, Restaurants, Incidents)
 *   5. Déploie la documentation auto (8 sections, ~50 pages)
 *   6. Affiche les IDs à mettre dans .env pour persister
 *
 * Ce script appelle directement les builders de docs/ + les helpers, sans
 * démarrer NestJS (évite de devoir avoir Postgres/Firebase/Redis configurés).
 */

import 'dotenv/config';
import { Client } from '@notionhq/client';
import path from 'node:path';

import {
  chunkBlocks,
  NotionBlock,
} from '../apps/lilia-app/src/modules/notion/docs/docs-block.helpers';
import { PageDef } from '../apps/lilia-app/src/modules/notion/docs/page-def.types';
import { buildBackendModulesSection } from '../apps/lilia-app/src/modules/notion/docs/sections/backend-modules.builder';
import { buildCeoDashboardSection } from '../apps/lilia-app/src/modules/notion/docs/sections/ceo-dashboard.builder';
import { buildClientAppSection } from '../apps/lilia-app/src/modules/notion/docs/sections/client-app.builder';
import { buildOperationsSection } from '../apps/lilia-app/src/modules/notion/docs/sections/operations.builder';
import { buildRestaurantsSection } from '../apps/lilia-app/src/modules/notion/docs/sections/restaurants.builder';
import { buildRiderAppSection } from '../apps/lilia-app/src/modules/notion/docs/sections/rider-app.builder';
import { buildRoadmapSection } from '../apps/lilia-app/src/modules/notion/docs/sections/roadmap.builder';
import { buildTechDocsSection } from '../apps/lilia-app/src/modules/notion/docs/sections/tech-docs.builder';
import { NOTION_PROPS } from '../apps/lilia-app/src/modules/notion/notion.constants';

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error('❌ NOTION_TOKEN absent dans .env');
  process.exit(1);
}

const client = new Client({ auth: TOKEN, notionVersion: '2022-06-28' });

// --- Throttle minimal (3 req/s) ---
const MIN_INTERVAL_MS = 350;
let lastReq = 0;
async function throttle() {
  const elapsed = Date.now() - lastReq;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastReq = Date.now();
}

async function retry<T>(label: string, fn: () => Promise<T>, max = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= max; i++) {
    try {
      await throttle();
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = (e as { code?: string })?.code;
      const retryable =
        code === 'rate_limited' ||
        code === 'internal_server_error' ||
        code === 'service_unavailable' ||
        code === 'conflict_error';
      if (!retryable || i === max) {
        console.error(`  ❌ ${label} échec (${i}/${max}):`, (e as Error).message);
        throw e;
      }
      const delay = 500 * Math.pow(3, i - 1);
      console.warn(`  ⚠️  ${label} retry ${i}/${max} dans ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ============ Step 1: Vérification token ============
async function checkToken() {
  console.log('\n🔑 Vérification du token Notion…');
  const me = await retry('users.me', () => client.users.me({}));
  console.log(`  ✓ Integration: ${(me as any).name ?? me.id}`);
}

// ============ Step 2: Trouver la workspace page ============
async function findWorkspacePage(): Promise<string> {
  const fromEnv = process.env.NOTION_WORKSPACE_PAGE_ID;
  if (fromEnv) {
    console.log(`\n📂 Workspace page depuis .env: ${fromEnv}`);
    return fromEnv;
  }

  console.log('\n🔍 NOTION_WORKSPACE_PAGE_ID absent — recherche des pages partagées avec l\'integration…');
  const res = await retry('search', () =>
    client.search({
      filter: { value: 'page', property: 'object' },
      page_size: 20,
    }),
  );

  const pages = (res as any).results as Array<{
    id: string;
    properties?: Record<string, any>;
    parent?: { type: string };
  }>;

  if (pages.length === 0) {
    console.error(
      '\n❌ Aucune page partagée avec l\'integration.\n' +
        '   → Dans Notion, ouvre une page, clique "..." → "Connections" → ajoute l\'integration.\n' +
        '   Puis re-lance ce script.',
    );
    process.exit(2);
  }

  console.log(`  ${pages.length} page(s) trouvée(s):`);
  for (const p of pages) {
    const title = extractTitle(p);
    console.log(`    - ${p.id}  →  ${title}`);
  }

  // On prend la première page de type "workspace" (top-level) si disponible,
  // sinon la première tout court.
  const topLevel = pages.find((p) => p.parent?.type === 'workspace');
  const chosen = topLevel ?? pages[0];
  console.log(`\n  → Utilisation de: ${chosen.id} (${extractTitle(chosen)})`);
  return chosen.id;
}

function extractTitle(p: { properties?: Record<string, any> }): string {
  if (!p.properties) return '<sans titre>';
  for (const k of Object.keys(p.properties)) {
    const prop = p.properties[k];
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map((t: any) => t.plain_text).join('') || '<sans titre>';
    }
  }
  return '<sans titre>';
}

// ============ Step 3: Page racine ============
async function ensureRootPage(workspaceId: string): Promise<string> {
  const fromEnv = process.env.NOTION_ROOT_PAGE_ID;
  if (fromEnv) {
    console.log(`\n📄 Page racine depuis .env: ${fromEnv}`);
    return fromEnv;
  }

  console.log('\n📄 Création de la page racine "LILIA FOOD OPERATIONS"…');
  const page = await retry('createRootPage', () =>
    client.pages.create({
      parent: { page_id: workspaceId },
      properties: {
        title: { title: [{ text: { content: 'LILIA FOOD OPERATIONS' } }] },
      } as any,
      icon: { type: 'emoji', emoji: '🍱' as any },
    }),
  );
  console.log(`  ✓ Page racine créée: ${page.id}`);
  return page.id;
}

// ============ Step 4: Databases ============
async function createDatabase(
  parentId: string,
  title: string,
  icon: string,
  properties: Record<string, unknown>,
): Promise<string> {
  console.log(`\n📊 Création de la database "${title}"…`);
  const db = await retry(`createDb(${title})`, () =>
    client.databases.create({
      parent: { type: 'page_id', page_id: parentId },
      title: [{ type: 'text', text: { content: title } }],
      icon: { type: 'emoji', emoji: icon as any },
      initial_data_source: { properties: properties as any },
    } as any),
  );
  const dsId = (db as any).data_sources?.[0]?.id;
  if (!dsId) throw new Error(`DB ${title} créée mais pas de data_source_id`);
  console.log(`  ✓ DB ${title}: ${db.id} / data_source ${dsId}`);
  return dsId;
}

async function bootstrapDatabases(
  rootId: string,
): Promise<{ orders: string; restaurants: string; incidents: string }> {
  const orders = await createDatabase(rootId, 'Orders', '🧾', buildOrdersSchema());
  const restaurants = await createDatabase(rootId, 'Restaurants', '🏪', buildRestaurantsSchema());
  const incidents = await createDatabase(rootId, 'Incidents', '🚨', buildIncidentsSchema());
  return { orders, restaurants, incidents };
}

function buildOrdersSchema() {
  const P = NOTION_PROPS.ORDERS;
  return {
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
  };
}

function buildRestaurantsSchema() {
  const P = NOTION_PROPS.RESTAURANTS;
  return {
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
  };
}

function buildIncidentsSchema() {
  const P = NOTION_PROPS.INCIDENTS;
  return {
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
  };
}

// ============ Step 5: Docs ============
async function deployPage(
  parentId: string,
  def: PageDef,
  depth = 0,
): Promise<{ created: number; skipped: number }> {
  const indent = '  '.repeat(depth);
  const existing = await findChildPageByTitle(parentId, def.title);
  let pageId: string;
  let created = 0;
  let skipped = 0;

  if (existing) {
    skipped++;
    console.log(`${indent}↩  "${def.title}" déjà existante — skip`);
    pageId = existing;
  } else {
    const page = await retry(`createPage(${def.title})`, () =>
      client.pages.create({
        parent: { page_id: parentId },
        properties: {
          title: { title: [{ text: { content: def.title } }] },
        } as any,
        ...(def.icon && { icon: { type: 'emoji', emoji: def.icon as any } }),
      }),
    );
    pageId = page.id;
    created++;
    console.log(`${indent}✓ "${def.title}" → ${page.id}`);

    if (def.children.length > 0) {
      const chunks = chunkBlocks(def.children);
      for (const chunk of chunks) {
        await retry(`appendBlocks(${def.title})`, () =>
          client.blocks.children.append({
            block_id: pageId,
            children: chunk as any,
          }),
        );
      }
    }
  }

  if (def.subPages?.length) {
    for (const sub of def.subPages) {
      const r = await deployPage(pageId, sub, depth + 1);
      created += r.created;
      skipped += r.skipped;
    }
  }

  return { created, skipped };
}

async function findChildPageByTitle(
  parentId: string,
  title: string,
): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const res = await retry(`listChildren(${parentId})`, () =>
      client.blocks.children.list({
        block_id: parentId,
        page_size: 100,
        ...(cursor && { start_cursor: cursor }),
      }),
    );
    const r = res as {
      results: Array<{ id: string; type?: string; child_page?: { title: string } }>;
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const b of r.results) {
      if (b.type === 'child_page' && b.child_page?.title === title) {
        return b.id;
      }
    }
    cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
  } while (cursor);
  return null;
}

async function bootstrapDocs(rootId: string) {
  console.log('\n📚 Déploiement de la documentation auto (8 sections)…');
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

  let totalCreated = 0;
  let totalSkipped = 0;
  for (const section of sections) {
    const r = await deployPage(rootId, section);
    totalCreated += r.created;
    totalSkipped += r.skipped;
  }
  return { totalCreated, totalSkipped };
}

// ============ Main ============
(async () => {
  console.log('🍱 Lilia Food — Bootstrap Notion');
  console.log('═════════════════════════════════');

  try {
    await checkToken();
    const workspaceId = await findWorkspacePage();
    const rootId = await ensureRootPage(workspaceId);
    const dbs = await bootstrapDatabases(rootId);
    const docs = await bootstrapDocs(rootId);

    console.log('\n═════════════════════════════════');
    console.log('✅ Bootstrap terminé.\n');
    console.log('📋 Pour persister, ajoute dans ton .env :');
    console.log(`   NOTION_WORKSPACE_PAGE_ID=${workspaceId}`);
    console.log(`   NOTION_ROOT_PAGE_ID=${rootId}`);
    console.log(`   NOTION_DB_ORDERS=${dbs.orders}`);
    console.log(`   NOTION_DB_RESTAURANTS=${dbs.restaurants}`);
    console.log(`   NOTION_DB_INCIDENTS=${dbs.incidents}`);
    console.log(`\n📊 Docs: ${docs.totalCreated} pages créées, ${docs.totalSkipped} skipped`);
  } catch (e) {
    console.error('\n💥 Bootstrap échoué:', (e as Error).message);
    if ((e as any).body) console.error('   Body:', (e as any).body);
    process.exit(3);
  }
})();
