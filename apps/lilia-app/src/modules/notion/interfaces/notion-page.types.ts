/**
 * Type minimal pour un payload de properties Notion.
 * On reste laxiste plutôt que d'importer les types lourds de @notionhq/client.
 */
export type NotionProperties = Record<string, unknown>;
