import type { ProductTimeFields } from './product-availability';

/**
 * Double de test des références de colonnes Prisma
 * (`prisma.product.fields.availableFrom`).
 *
 * Une référence de champ n'est pas une valeur : c'est un marqueur que Prisma
 * traduit en **nom de colonne** dans le SQL généré. En test unitaire on n'a pas
 * de client, mais on a besoin de reconnaître ce marqueur pour rejouer la
 * sémantique de la comparaison colonne-à-colonne. Deux sentinelles suffisent —
 * et le fait qu'elles soient des chaînes reconnaissables rend les échecs de test
 * lisibles.
 */
export const COLUMN_REF = {
  availableFrom: '§ref:availableFrom',
  availableUntil: '§ref:availableUntil',
} as const;

export const FAKE_PRODUCT_TIME_FIELDS =
  COLUMN_REF as unknown as ProductTimeFields;
