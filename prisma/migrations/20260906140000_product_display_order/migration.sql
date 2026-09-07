-- Ordre d'affichage des produits dans la carte d'un vendeur.
--
-- Entièrement ADDITIVE : une instance de l'ancien code tourne dessus sans
-- rien savoir de la colonne. Aucune migration de données n'est nécessaire —
-- le défaut `1000` place tout l'existant à égalité, et le tri secondaire
-- (`createdAt DESC`) le départage exactement comme aujourd'hui.
--
-- Défaut 1000 et non 0 : avec 0, « pas encore classé » et « tout premier »
-- seraient la même valeur, et chaque nouveau produit passerait en tête de
-- section par accident. Même convention que `Restaurant.displayOrder`.
ALTER TABLE "Product" ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 1000;

-- Sert le tri du menu : « les produits d'un vendeur, dans l'ordre ».
CREATE INDEX "Product_restaurantId_displayOrder_idx" ON "Product"("restaurantId", "displayOrder");

-- Les variantes n'ont pas d'ordre déclaré : elles sont triées par prix
-- croissant. Sans cet index, chaque produit du menu déclencherait un tri.
CREATE INDEX "ProductVariant_productId_prix_idx" ON "ProductVariant"("productId", "prix");
