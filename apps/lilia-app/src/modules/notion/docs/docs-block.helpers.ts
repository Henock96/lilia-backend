/**
 * Helpers de construction de blocks Notion.
 *
 * Notion impose un maximum de 100 children par requête `blocks.children.append`
 * et 2000 caractères par rich_text item. Les helpers ci-dessous découpent
 * automatiquement.
 *
 * On garde un typage laxiste (`unknown` / `Record<string, any>`) car
 * @notionhq/client expose des types très imbriqués pour la moindre option ;
 * notre code n'en a pas besoin pour générer du contenu structuré.
 */

export type NotionBlock = Record<string, unknown>;

const MAX_RT = 2000;
export const MAX_CHILDREN_PER_REQUEST = 100;

function rt(content: string, opts?: { bold?: boolean; code?: boolean }) {
  return {
    type: 'text',
    text: { content: content.slice(0, MAX_RT) },
    annotations: {
      bold: !!opts?.bold,
      code: !!opts?.code,
    },
  };
}

export function h1(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'heading_1',
    heading_1: { rich_text: [rt(text)] },
  };
}

export function h2(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [rt(text)] },
  };
}

export function h3(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'heading_3',
    heading_3: { rich_text: [rt(text)] },
  };
}

export function p(...parts: Array<string | NotionRichText>): NotionBlock {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: parts.map(normalizeRich) },
  };
}

export function bullet(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [rt(text)] },
  };
}

export function bullets(items: string[]): NotionBlock[] {
  return items.map(bullet);
}

export function numbered(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'numbered_list_item',
    numbered_list_item: { rich_text: [rt(text)] },
  };
}

export function callout(
  text: string,
  emoji = '💡',
  color:
    | 'default'
    | 'blue_background'
    | 'green_background'
    | 'orange_background'
    | 'red_background'
    | 'yellow_background' = 'blue_background',
): NotionBlock {
  return {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [rt(text)],
      icon: { type: 'emoji', emoji },
      color,
    },
  };
}

export function code(
  content: string,
  language:
    | 'typescript'
    | 'javascript'
    | 'json'
    | 'bash'
    | 'shell'
    | 'sql'
    | 'plain text' = 'typescript',
): NotionBlock {
  // Notion limite à 2000 chars par rich_text — on tronque proprement.
  const safe = content.length > MAX_RT ? content.slice(0, MAX_RT - 30) + '\n// ...tronqué' : content;
  return {
    object: 'block',
    type: 'code',
    code: {
      rich_text: [rt(safe)],
      language,
    },
  };
}

export function divider(): NotionBlock {
  return { object: 'block', type: 'divider', divider: {} };
}

export function quote(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'quote',
    quote: { rich_text: [rt(text)] },
  };
}

export function toggle(title: string, children: NotionBlock[]): NotionBlock {
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [rt(title)],
      children,
    },
  };
}

/**
 * Construit un tableau Notion (table block). `headers` et `rows` doivent
 * avoir la même longueur de colonnes.
 */
export function table(headers: string[], rows: string[][]): NotionBlock {
  const tableRow = (cells: string[]) => ({
    object: 'block',
    type: 'table_row',
    table_row: { cells: cells.map((c) => [rt(c)]) },
  });

  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: headers.length,
      has_column_header: true,
      has_row_header: false,
      children: [tableRow(headers), ...rows.map(tableRow)],
    },
  };
}

export type NotionRichText = ReturnType<typeof rt>;

function normalizeRich(part: string | NotionRichText): NotionRichText {
  return typeof part === 'string' ? rt(part) : part;
}

/** Texte en ligne formaté en code monospace — utile dans un paragraphe. */
export function inlineCode(text: string): NotionRichText {
  return rt(text, { code: true });
}

export function inlineBold(text: string): NotionRichText {
  return rt(text, { bold: true });
}

/** Découpe un tableau de blocks en chunks pour respecter la limite Notion. */
export function chunkBlocks(blocks: NotionBlock[]): NotionBlock[][] {
  const out: NotionBlock[][] = [];
  for (let i = 0; i < blocks.length; i += MAX_CHILDREN_PER_REQUEST) {
    out.push(blocks.slice(i, i + MAX_CHILDREN_PER_REQUEST));
  }
  return out;
}
