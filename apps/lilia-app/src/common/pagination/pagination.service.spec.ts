import { PaginationService } from './pagination.service';

/**
 * `getPaginationMeta` est le SEUL constructeur de `meta` du dépôt qui
 * n'exposait pas `total` — les neuf autres (`refunds`, `admin-audit`,
 * `menus`, `deliveries`, `reviews`, `admin-vendors`, `payouts`,
 * `delivery-reviews`) le portent tous à la main.
 *
 * Conséquence concrète : `GET /orders/restaurant` annonce un nombre de pages
 * mais pas un nombre d'éléments. Un front qui veut afficher « 148 commandes »
 * n'a aucune source, et se rabat sur `items.length` — c'est-à-dire la taille
 * de la page. C'est exactement le défaut corrigé en août sur le badge des
 * remboursements, resté ici.
 */
describe('PaginationService.getPaginationMeta', () => {
  const service = new PaginationService();

  it('expose le total d’éléments, pas seulement le nombre de pages', () => {
    expect(service.getPaginationMeta(2, 20, 148)).toEqual({
      page: 2,
      limit: 20,
      total: 148,
      totalPages: 8,
    });
  });

  it('annonce au moins une page sur un résultat vide', () => {
    // `Math.ceil(0 / 20)` vaut 0 : une interface qui affiche « page 1/0 »
    // laisse croire à une erreur là où il n'y a simplement rien.
    expect(service.getPaginationMeta(1, 20, 0)).toEqual({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 1,
    });
  });

  it('arrondit la dernière page incomplète vers le haut', () => {
    expect(service.getPaginationMeta(1, 20, 21).totalPages).toBe(2);
  });
});
