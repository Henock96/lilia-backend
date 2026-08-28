-- Audit des lignes orphelines avant le passage à relationMode = "foreignKeys".
--
-- `relationMode = "prisma"` désactive les clés étrangères au niveau base : rien
-- n'a jamais empêché une écriture hors Prisma (psql, script d'admin, outil de
-- BI, migration SQL manuelle) de créer des lignes pointant vers un parent
-- inexistant. PostgreSQL refusera de créer les contraintes tant qu'il en
-- restera une seule.
--
-- 100 % LECTURE SEULE. À exécuter sur la base de production AVANT la migration :
--   psql "$DATABASE_URL" -f prisma/scripts/audit-orphans.sql
--
-- Toute ligne dont `orphelins` > 0 doit être traitée (voir cleanup-orphans.sql).

SELECT 'Adresses.quartierId -> Quartier.id' AS relation, COUNT(*) AS orphelins
FROM "Adresses" c
LEFT JOIN "Quartier" p ON c."quartierId" = p."id"
WHERE c."quartierId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Adresses.userId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "Adresses" c
LEFT JOIN "User" p ON c."userId" = p."id"
WHERE c."userId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Banner.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "Banner" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Cart.userId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "Cart" c
LEFT JOIN "User" p ON c."userId" = p."id"
WHERE c."userId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'CartItem.cartId -> Cart.id' AS relation, COUNT(*) AS orphelins
FROM "CartItem" c
LEFT JOIN "Cart" p ON c."cartId" = p."id"
WHERE c."cartId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'CartItem.menuId -> MenuDuJour.id' AS relation, COUNT(*) AS orphelins
FROM "CartItem" c
LEFT JOIN "MenuDuJour" p ON c."menuId" = p."id"
WHERE c."menuId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'CartItem.productId -> Product.id' AS relation, COUNT(*) AS orphelins
FROM "CartItem" c
LEFT JOIN "Product" p ON c."productId" = p."id"
WHERE c."productId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'CartItem.variantId -> ProductVariant.id' AS relation, COUNT(*) AS orphelins
FROM "CartItem" c
LEFT JOIN "ProductVariant" p ON c."variantId" = p."id"
WHERE c."variantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Delivery.delivererId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "Delivery" c
LEFT JOIN "User" p ON c."delivererId" = p."id"
WHERE c."delivererId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Delivery.orderId -> Order.id' AS relation, COUNT(*) AS orphelins
FROM "Delivery" c
LEFT JOIN "Order" p ON c."orderId" = p."id"
WHERE c."orderId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'DeliveryLocation.deliveryId -> Delivery.id' AS relation, COUNT(*) AS orphelins
FROM "DeliveryLocation" c
LEFT JOIN "Delivery" p ON c."deliveryId" = p."id"
WHERE c."deliveryId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'DeliveryZone.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "DeliveryZone" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Favorite.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "Favorite" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Favorite.userId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "Favorite" c
LEFT JOIN "User" p ON c."userId" = p."id"
WHERE c."userId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'FcmToken.userId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "FcmToken" c
LEFT JOIN "User" p ON c."userId" = p."id"
WHERE c."userId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'LoyaltyTransaction.userId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "LoyaltyTransaction" c
LEFT JOIN "User" p ON c."userId" = p."id"
WHERE c."userId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'MenuDuJour.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "MenuDuJour" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'MenuImage.menuDuJourId -> MenuDuJour.id' AS relation, COUNT(*) AS orphelins
FROM "MenuImage" c
LEFT JOIN "MenuDuJour" p ON c."menuDuJourId" = p."id"
WHERE c."menuDuJourId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'MenuProduct.menuId -> MenuDuJour.id' AS relation, COUNT(*) AS orphelins
FROM "MenuProduct" c
LEFT JOIN "MenuDuJour" p ON c."menuId" = p."id"
WHERE c."menuId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'MenuProduct.productId -> Product.id' AS relation, COUNT(*) AS orphelins
FROM "MenuProduct" c
LEFT JOIN "Product" p ON c."productId" = p."id"
WHERE c."productId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'OperatingHours.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "OperatingHours" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Order.promoCodeId -> PromoCode.id' AS relation, COUNT(*) AS orphelins
FROM "Order" c
LEFT JOIN "PromoCode" p ON c."promoCodeId" = p."id"
WHERE c."promoCodeId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Order.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "Order" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Order.userId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "Order" c
LEFT JOIN "User" p ON c."userId" = p."id"
WHERE c."userId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'OrderHistory.orderId -> Order.id' AS relation, COUNT(*) AS orphelins
FROM "OrderHistory" c
LEFT JOIN "Order" p ON c."orderId" = p."id"
WHERE c."orderId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'OrderItem.menuId -> MenuDuJour.id' AS relation, COUNT(*) AS orphelins
FROM "OrderItem" c
LEFT JOIN "MenuDuJour" p ON c."menuId" = p."id"
WHERE c."menuId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'OrderItem.orderId -> Order.id' AS relation, COUNT(*) AS orphelins
FROM "OrderItem" c
LEFT JOIN "Order" p ON c."orderId" = p."id"
WHERE c."orderId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'OrderItem.productId -> Product.id' AS relation, COUNT(*) AS orphelins
FROM "OrderItem" c
LEFT JOIN "Product" p ON c."productId" = p."id"
WHERE c."productId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Payment.orderId -> Order.id' AS relation, COUNT(*) AS orphelins
FROM "payments" c
LEFT JOIN "Order" p ON c."orderId" = p."id"
WHERE c."orderId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Product.categoryId -> Category.id' AS relation, COUNT(*) AS orphelins
FROM "Product" c
LEFT JOIN "Category" p ON c."categoryId" = p."id"
WHERE c."categoryId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Product.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "Product" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'ProductImage.productId -> Product.id' AS relation, COUNT(*) AS orphelins
FROM "ProductImage" c
LEFT JOIN "Product" p ON c."productId" = p."id"
WHERE c."productId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'ProductVariant.productId -> Product.id' AS relation, COUNT(*) AS orphelins
FROM "ProductVariant" c
LEFT JOIN "Product" p ON c."productId" = p."id"
WHERE c."productId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'PromoCode.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "PromoCode" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'PromoUsage.promoCodeId -> PromoCode.id' AS relation, COUNT(*) AS orphelins
FROM "PromoUsage" c
LEFT JOIN "PromoCode" p ON c."promoCodeId" = p."id"
WHERE c."promoCodeId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'PromoUsage.userId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "PromoUsage" c
LEFT JOIN "User" p ON c."userId" = p."id"
WHERE c."userId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'QuartierZone.deliveryZoneId -> DeliveryZone.id' AS relation, COUNT(*) AS orphelins
FROM "QuartierZone" c
LEFT JOIN "DeliveryZone" p ON c."deliveryZoneId" = p."id"
WHERE c."deliveryZoneId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'QuartierZone.quartierId -> Quartier.id' AS relation, COUNT(*) AS orphelins
FROM "QuartierZone" c
LEFT JOIN "Quartier" p ON c."quartierId" = p."id"
WHERE c."quartierId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Restaurant.ownerId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "Restaurant" c
LEFT JOIN "User" p ON c."ownerId" = p."id"
WHERE c."ownerId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Review.orderId -> Order.id' AS relation, COUNT(*) AS orphelins
FROM "Review" c
LEFT JOIN "Order" p ON c."orderId" = p."id"
WHERE c."orderId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Review.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "Review" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Review.userId -> User.id' AS relation, COUNT(*) AS orphelins
FROM "Review" c
LEFT JOIN "User" p ON c."userId" = p."id"
WHERE c."userId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'Specialty.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "Specialty" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'VendorPhoto.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "VendorPhoto" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
UNION ALL
SELECT 'VendorProfile.restaurantId -> Restaurant.id' AS relation, COUNT(*) AS orphelins
FROM "VendorProfile" c
LEFT JOIN "Restaurant" p ON c."restaurantId" = p."id"
WHERE c."restaurantId" IS NOT NULL AND p."id" IS NULL
ORDER BY orphelins DESC, relation;
