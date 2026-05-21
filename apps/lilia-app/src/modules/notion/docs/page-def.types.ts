import { NotionBlock } from './docs-block.helpers';

/**
 * Définition d'une page Notion à créer dans le wiki.
 * Récursive : `subPages` permet d'imbriquer des sous-pages.
 */
export interface PageDef {
  title: string;
  icon?: string;
  children: NotionBlock[];
  subPages?: PageDef[];
}
