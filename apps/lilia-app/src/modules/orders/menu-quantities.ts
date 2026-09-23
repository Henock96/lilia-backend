/**
 * Combien de **menus** une liste de lignes (panier ou commande) représente-t-elle ?
 *
 * Un menu n'a pas de ligne à lui : `addMenu` crée **une ligne par produit du
 * menu**, toutes portant le même `menuId` et la même `quantite` (le nombre de
 * menus). Un menu de 3 plats commandé 2 fois = 3 lignes à `quantite = 2`.
 *
 * ⚠️ Additionner `quantite` sur les lignes du groupe compte donc le menu
 * `N × q` fois au lieu de `q` (finding F-01 du Master Audit v1) : un menu de
 * 3 plats au stock de 10 s'épuisait après 3 commandes, et un stock restant de 2
 * interdisait d'en commander un seul.
 *
 * La quantité d'un menu est celle de la **première** ligne de son groupe —
 * exactement la règle qu'applique `OrderCalculatorService` au prix
 * (`groupItems[0].menu.prix × groupItems[0].quantite`). Prix, validation,
 * décrémentation et restitution parlent ainsi du même nombre de menus.
 *
 * Les produits contenus dans le menu restent décomptés ligne par ligne : chaque
 * ligne est un produit réellement consommé (`MenuProduct` n'a pas de quantité,
 * un produit figure au plus une fois par menu).
 */
export function countMenus(
  lines: ReadonlyArray<{ menuId?: string | null; quantite: number }>,
): Map<string, number> {
  const menus = new Map<string, number>();
  for (const line of lines) {
    if (!line.menuId || menus.has(line.menuId)) continue;
    menus.set(line.menuId, line.quantite);
  }
  return menus;
}
