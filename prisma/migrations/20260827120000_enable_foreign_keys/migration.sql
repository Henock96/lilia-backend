-- Active les clés étrangères au niveau base (relationMode "prisma" → "foreignKeys").
--
-- CONTEXTE
-- `relationMode = "prisma"` désactivait les FK et faisait émuler les relations
-- par le client Prisma. Sur PostgreSQL, qui les supporte nativement, cela
-- revenait à renoncer à toute garantie d'intégrité : n'importe quelle écriture
-- hors Prisma (psql, script d'admin, outil de BI, migration SQL manuelle)
-- pouvait créer des lignes pointant vers un parent inexistant.
--
-- Ce n'était pas théorique : l'audit du 27/08/2026 (`prisma/scripts/audit-orphans.sql`)
-- a trouvé 24 lignes orphelines sur 5 relations, toutes des résidus de comptes
-- de test supprimés.
--
-- STRUCTURE DE CETTE MIGRATION
--   1. Nettoyage des orphelins « accessoires » — PostgreSQL refuse de créer une
--      contrainte tant qu'une seule ligne la viole. Sans cette étape, la
--      migration échouerait au déploiement.
--   2. Création des 45 contraintes.
--
-- Prisma exécute la migration dans une transaction : en cas d'échec à l'étape 2,
-- le nettoyage de l'étape 1 est annulé lui aussi.
--
-- CE QUI N'EST VOLONTAIREMENT PAS NETTOYÉ
-- Aucun DELETE n'est fait sur les tables à valeur comptable ou métier — Order,
-- OrderItem, payments, Delivery, Product, Restaurant, MenuDuJour, User. Si un
-- orphelin y apparaissait, la migration **échouerait**, et c'est voulu : ces
-- lignes-là demandent un arbitrage humain, pas une suppression automatique.
-- Relancer `node scripts/db/audit-orphans.js` pour identifier le cas.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Nettoyage des orphelins accessoires
-- ─────────────────────────────────────────────────────────────────────────────

-- 1.a Relations OPTIONNELLES : la référence est remise à NULL, la ligne est
--     conservée. Une adresse dont le quartier a disparu reste une adresse.

UPDATE "Adresses"      SET "quartierId"     = NULL WHERE "quartierId"     IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Quartier"     p WHERE p.id = "Adresses"."quartierId");
UPDATE "Order"         SET "promoCodeId"    = NULL WHERE "promoCodeId"    IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PromoCode"    p WHERE p.id = "Order"."promoCodeId");
UPDATE "Product"       SET "categoryId"     = NULL WHERE "categoryId"     IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Category"     p WHERE p.id = "Product"."categoryId");
UPDATE "Delivery"      SET "delivererId"    = NULL WHERE "delivererId"    IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User"         p WHERE p.id = "Delivery"."delivererId");
UPDATE "Review"        SET "orderId"        = NULL WHERE "orderId"        IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Order"        p WHERE p.id = "Review"."orderId");
UPDATE "OrderItem"     SET "menuId"         = NULL WHERE "menuId"         IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "MenuDuJour"   p WHERE p.id = "OrderItem"."menuId");
UPDATE "CartItem"      SET "menuId"         = NULL WHERE "menuId"         IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "MenuDuJour"   p WHERE p.id = "CartItem"."menuId");
UPDATE "PromoCode"     SET "restaurantId"   = NULL WHERE "restaurantId"   IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Restaurant"   p WHERE p.id = "PromoCode"."restaurantId");
UPDATE "Banner"        SET "restaurantId"   = NULL WHERE "restaurantId"   IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Restaurant"   p WHERE p.id = "Banner"."restaurantId");

-- 1.b Relations REQUISES sur des tables accessoires : la ligne n'a plus aucun
--     sens sans son parent, on la supprime.
--     Ordre imposé par les dépendances : enfants avant parents.

-- Lignes de panier dont le panier, le produit, la variante ou le propriétaire a disparu
DELETE FROM "CartItem" WHERE NOT EXISTS (SELECT 1 FROM "Cart"           p WHERE p.id = "CartItem"."cartId");
DELETE FROM "CartItem" WHERE NOT EXISTS (SELECT 1 FROM "Product"        p WHERE p.id = "CartItem"."productId");
DELETE FROM "CartItem" WHERE NOT EXISTS (SELECT 1 FROM "ProductVariant" p WHERE p.id = "CartItem"."variantId");
-- Paniers de comptes supprimés (9 au moment de l'audit, tous vides)
DELETE FROM "Cart"     WHERE NOT EXISTS (SELECT 1 FROM "User"           p WHERE p.id = "Cart"."userId");

-- Adresses de comptes supprimés (8). L'historique des commandes n'est pas touché :
-- `Order.deliveryAddress` stocke l'adresse en texte, pas une référence.
DELETE FROM "Adresses" WHERE NOT EXISTS (SELECT 1 FROM "User" p WHERE p.id = "Adresses"."userId");

-- Tokens push de comptes supprimés (5) : ils ne peuvent plus rien recevoir.
DELETE FROM "FcmToken" WHERE NOT EXISTS (SELECT 1 FROM "User" p WHERE p.id = "FcmToken"."userId");

-- Favoris, historique de fidélité et usages de promo de comptes supprimés
DELETE FROM "Favorite"           WHERE NOT EXISTS (SELECT 1 FROM "User"       p WHERE p.id = "Favorite"."userId");
DELETE FROM "Favorite"           WHERE NOT EXISTS (SELECT 1 FROM "Restaurant" p WHERE p.id = "Favorite"."restaurantId");
DELETE FROM "LoyaltyTransaction" WHERE NOT EXISTS (SELECT 1 FROM "User"       p WHERE p.id = "LoyaltyTransaction"."userId");
DELETE FROM "PromoUsage"         WHERE NOT EXISTS (SELECT 1 FROM "User"       p WHERE p.id = "PromoUsage"."userId");
DELETE FROM "PromoUsage"         WHERE NOT EXISTS (SELECT 1 FROM "PromoCode"  p WHERE p.id = "PromoUsage"."promoCodeId");

-- Avis dont l'auteur ou le vendeur a disparu (1 au moment de l'audit, 5★).
-- `Review.userId` est requis : impossible de conserver l'avis en l'anonymisant
-- sans changer le schéma. La note moyenne du vendeur concerné bougera donc
-- légèrement.
DELETE FROM "Review" WHERE NOT EXISTS (SELECT 1 FROM "User"       p WHERE p.id = "Review"."userId");
DELETE FROM "Review" WHERE NOT EXISTS (SELECT 1 FROM "Restaurant" p WHERE p.id = "Review"."restaurantId");

-- Contenus rattachés à un vendeur supprimé (VendorProfile : 1 au moment de l'audit)
DELETE FROM "VendorProfile"  WHERE NOT EXISTS (SELECT 1 FROM "Restaurant" p WHERE p.id = "VendorProfile"."restaurantId");
DELETE FROM "Specialty"      WHERE NOT EXISTS (SELECT 1 FROM "Restaurant" p WHERE p.id = "Specialty"."restaurantId");
DELETE FROM "OperatingHours" WHERE NOT EXISTS (SELECT 1 FROM "Restaurant" p WHERE p.id = "OperatingHours"."restaurantId");
DELETE FROM "VendorPhoto"    WHERE NOT EXISTS (SELECT 1 FROM "Restaurant" p WHERE p.id = "VendorPhoto"."restaurantId");
DELETE FROM "DeliveryZone"   WHERE NOT EXISTS (SELECT 1 FROM "Restaurant" p WHERE p.id = "DeliveryZone"."restaurantId");

-- Zones / quartiers
DELETE FROM "QuartierZone" WHERE NOT EXISTS (SELECT 1 FROM "Quartier"     p WHERE p.id = "QuartierZone"."quartierId");
DELETE FROM "QuartierZone" WHERE NOT EXISTS (SELECT 1 FROM "DeliveryZone" p WHERE p.id = "QuartierZone"."deliveryZoneId");

-- Médias et sous-objets orphelins
DELETE FROM "ProductImage"     WHERE NOT EXISTS (SELECT 1 FROM "Product"    p WHERE p.id = "ProductImage"."productId");
DELETE FROM "ProductVariant"   WHERE NOT EXISTS (SELECT 1 FROM "Product"    p WHERE p.id = "ProductVariant"."productId");
DELETE FROM "MenuImage"        WHERE NOT EXISTS (SELECT 1 FROM "MenuDuJour" p WHERE p.id = "MenuImage"."menuDuJourId");
DELETE FROM "MenuProduct"      WHERE NOT EXISTS (SELECT 1 FROM "MenuDuJour" p WHERE p.id = "MenuProduct"."menuId");
DELETE FROM "MenuProduct"      WHERE NOT EXISTS (SELECT 1 FROM "Product"    p WHERE p.id = "MenuProduct"."productId");
DELETE FROM "DeliveryLocation" WHERE NOT EXISTS (SELECT 1 FROM "Delivery"   p WHERE p.id = "DeliveryLocation"."deliveryId");
DELETE FROM "OrderHistory"     WHERE NOT EXISTS (SELECT 1 FROM "Order"      p WHERE p.id = "OrderHistory"."orderId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Création des contraintes (généré par `prisma migrate diff`)
-- ─────────────────────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FcmToken" ADD CONSTRAINT "FcmToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adresses" ADD CONSTRAINT "Adresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adresses" ADD CONSTRAINT "Adresses_quartierId_fkey" FOREIGN KEY ("quartierId") REFERENCES "Quartier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorProfile" ADD CONSTRAINT "VendorProfile_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Specialty" ADD CONSTRAINT "Specialty_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuDuJour" ADD CONSTRAINT "MenuDuJour_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuProduct" ADD CONSTRAINT "MenuProduct_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "MenuDuJour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuProduct" ADD CONSTRAINT "MenuProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "MenuDuJour"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "MenuDuJour"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHistory" ADD CONSTRAINT "OrderHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_delivererId_fkey" FOREIGN KEY ("delivererId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryLocation" ADD CONSTRAINT "DeliveryLocation_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuartierZone" ADD CONSTRAINT "QuartierZone_quartierId_fkey" FOREIGN KEY ("quartierId") REFERENCES "Quartier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuartierZone" ADD CONSTRAINT "QuartierZone_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPhoto" ADD CONSTRAINT "VendorPhoto_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuImage" ADD CONSTRAINT "MenuImage_menuDuJourId_fkey" FOREIGN KEY ("menuDuJourId") REFERENCES "MenuDuJour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingHours" ADD CONSTRAINT "OperatingHours_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoUsage" ADD CONSTRAINT "PromoUsage_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoUsage" ADD CONSTRAINT "PromoUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
