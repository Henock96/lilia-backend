/**
 * Normalisation du nom d'une section de menu.
 *
 * Le `slug` porte l'unicité par vendeur (`@@unique([restaurantId, slug])`)
 * plutôt que le libellé brut. C'est ce qui fait que « Boissons », « boissons »
 * et « Boissons  » désignent la même section chez un vendeur donné, alors que
 * l'ancien `nom @unique` global les acceptait toutes les trois — une contrainte
 * qui bloquait un second commerçant de bonne foi tout en se contournant d'une
 * simple majuscule.
 */

/** Longueur maximale d'un libellé de section, alignée sur le DTO. */
export const CATEGORY_NAME_MAX_LENGTH = 60;

/**
 * « Pâtisseries maison ! » → « patisseries-maison ».
 *
 * Les accents sont dépliés par `NFD` puis les diacritiques retirés : sans
 * cela « Pâtisseries » et « Patisseries » cohabiteraient chez le même vendeur.
 */
export function slugifyCategoryName(nom: string): string {
  const slug = nom
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Un libellé entièrement non-latin (« 飲み物 ») produirait une chaîne vide,
  // qui ne peut pas porter une contrainte d'unicité utile. On retombe alors
  // sur une forme stable dérivée du libellé.
  return slug || `categorie-${hashLabel(nom)}`;
}

/** Empreinte courte et déterministe, uniquement pour le repli ci-dessus. */
function hashLabel(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
