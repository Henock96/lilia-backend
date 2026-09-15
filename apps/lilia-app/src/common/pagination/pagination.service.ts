import { Injectable } from '@nestjs/common';

/**
 * Constructeur unique de l'enveloppe `meta` des routes paginées.
 *
 * ⚠️ `total` en fait partie. Il manquait, et c'était le seul `meta` du dépôt
 * dans ce cas : un front qui voulait annoncer « 148 commandes » n'avait aucune
 * source et se rabattait sur `items.length`, c'est-à-dire la taille de la page.
 * Le badge des remboursements a eu exactement ce défaut en août.
 *
 * `totalPages` vaut au minimum 1 : `Math.ceil(0 / 20)` donne 0, et « page 1/0 »
 * se lit comme une erreur là où il n'y a simplement rien à afficher.
 */
@Injectable()
export class PaginationService {
  getPaginationMeta(page: number, limit: number, totalItems: number) {
    return {
      page,
      limit,
      total: totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / limit)),
    };
  }
}
