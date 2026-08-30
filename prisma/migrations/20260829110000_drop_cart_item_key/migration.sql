-- Retrait de `CartItem.itemKey` — colonne morte.
--
-- Introduite le 04/04/2026 comme « index de remplacement » pour dédoublonner
-- les lignes de panier, elle n'a jamais été écrite ni lue par le code (grep
-- exhaustif : seules sa déclaration et son index apparaissent). Le problème
-- qu'elle devait résoudre — deux lignes identiques quand `menuId IS NULL`,
-- l'unicité composite ne les couvrant pas puisque NULL != NULL en PostgreSQL —
-- a été traité le 28/08 par un index unique PARTIEL
-- (`CartItem_cartId_variantId_individual_key`).
--
-- La garder entretenait la confusion sur la façon dont l'unicité est
-- réellement garantie. Sa valeur était dérivable de productId/variantId/menuId :
-- aucune information n'est perdue.

DROP INDEX IF EXISTS "CartItem_cartId_itemKey_idx";
ALTER TABLE "CartItem" DROP COLUMN IF EXISTS "itemKey";
