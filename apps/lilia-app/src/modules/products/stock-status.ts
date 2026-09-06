import { Prisma } from '@prisma/client';

/**
 * Filtre « où en est mon stock ? » pour la vue gestionnaire.
 *
 * ### Pourquoi côté serveur
 *
 * L'audit du 05/09/2026 relevait qu'aucune surface ne permettait de retrouver
 * les produits en rupture : l'admin web les colorait en rouge, mais dans une
 * liste paginée de tout le catalogue. Un vendeur de cinquante références devait
 * parcourir trois pages pour trouver les deux qu'il doit réassortir.
 *
 * Le filtre vit ici plutôt que dans l'interface parce qu'il porte sur des
 * lignes que le client **n'a pas** : filtrer une page déjà paginée ne rendrait
 * que les ruptures de cette page-là. C'est le même piège que « demander plus »
 * pour compenser une pagination.
 *
 * ### Le seuil « bientôt épuisé »
 *
 * `LOW_STOCK_THRESHOLD = 3` reprend exactement la valeur que l'admin web
 * utilisait déjà pour colorer en ambre (`stockRestant <= 3`). La reprendre
 * plutôt qu'en choisir une nouvelle évite que la liste filtrée et la couleur
 * de la carte se contredisent — deux seuils pour une même notion finissent
 * toujours par diverger.
 */
export const LOW_STOCK_THRESHOLD = 3;

export type StockStatus = 'out' | 'low' | 'unlimited' | 'tracked';

/**
 * Traduit un statut en clause Prisma.
 *
 * ⚠️ `stockRestant: null` signifie **illimité**, pas « zéro ». Les deux
 * branches qui touchent au stock fini exigent donc explicitement `not: null` :
 * sans cela, `{ lte: 3 }` ferait tomber les produits illimités dans « bientôt
 * épuisé » sur certains moteurs, et surtout la lecture du code laisserait
 * planer le doute.
 */
export function stockStatusWhere(
  status: StockStatus,
): Prisma.ProductWhereInput {
  switch (status) {
    case 'out':
      return { stockRestant: 0 };
    case 'low':
      // Strictement au-dessus de 0 : une rupture n'est pas un « stock faible »,
      // elle appelle un autre geste et a son propre filtre.
      return { stockRestant: { gt: 0, lte: LOW_STOCK_THRESHOLD } };
    case 'unlimited':
      return { stockRestant: null };
    case 'tracked':
      return { stockRestant: { not: null } };
  }
}
