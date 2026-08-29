-- Disponibilité et retrait des produits (fixes M1 + M2, audit du 28/08/2026).
--
-- M2 : depuis l'activation des clés étrangères (Ar1), `OrderItem.productId` est
-- en RESTRICT — `DELETE /products/:id` renvoyait donc 409 dès la première vente.
-- Le seul contournement, `stockQuotidien = 0`, affiche « épuisé » et non
-- « retiré ». On sépare les deux notions :
--   · isAvailable = false → indisponible temporairement (le vendeur le remettra)
--   · deletedAt IS NOT NULL → retiré du catalogue, ligne conservée pour que
--     l'historique des commandes reste lisible.
--
-- M1 : `availableFrom` / `availableUntil` existaient déjà mais n'étaient jamais
-- relus. Ils sont désormais appliqués au catalogue, au panier et au checkout —
-- aucun changement de schéma nécessaire, seulement du code.

ALTER TABLE "Product"
  ADD COLUMN "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deletedAt"   TIMESTAMP(3);

-- Catalogue vendeur filtré sur les produits vivants et disponibles.
CREATE INDEX "Product_restaurantId_deletedAt_isAvailable_idx"
  ON "Product"("restaurantId", "deletedAt", "isAvailable");
