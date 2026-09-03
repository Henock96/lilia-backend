-- ═══════════════════════════════════════════════════════════════════════════
-- Category devient une SECTION DE MENU appartenant à un vendeur
-- + montants du catalogue en entiers (le XAF n'a pas de sous-unité)
--
-- Jouable sur base vierge ET sur une base peuplée : les étapes 2 à 4
-- n'existent que pour la seconde.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Slug SQL, miroir de `slugifyCategoryName` (category-slug.ts) ───────────
-- `translate` plutôt que l'extension `unaccent` : une migration ne doit pas
-- dépendre d'une extension qui peut ne pas être installée sur l'instance cible.
-- La table de correspondance couvre les diacritiques du français, seul jeu
-- présent dans les libellés existants.
CREATE OR REPLACE FUNCTION lilia_category_slug(txt text) RETURNS text AS $$
  SELECT COALESCE(
    NULLIF(
      trim(both '-' from regexp_replace(
        lower(translate(txt,
          'àâäáãåçéèêëíìîïñóòôöõúùûüýÿÀÂÄÁÃÅÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ',
          'aaaaaaceeeeiiiinooooouuuuyyaaaaaaceeeeiiiinooooouuuuy')),
        '[^a-z0-9]+', '-', 'g')),
      ''),
    'categorie');
$$ LANGUAGE sql IMMUTABLE;

-- ─── 1. Nouvelles colonnes, nullables d'abord ──────────────────────────────
ALTER TABLE "Category"
  ADD COLUMN "restaurantId" TEXT,
  ADD COLUMN "slug"         TEXT,
  ADD COLUMN "description"  TEXT,
  ADD COLUMN "imageUrl"     TEXT,
  ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "isActive"     BOOLEAN NOT NULL DEFAULT true;

UPDATE "Category" SET "slug" = lilia_category_slug("nom");

-- L'unicité GLOBALE du nom tombe ICI, et non au verrouillage final : c'est elle
-- qui interdisait à deux commerçants d'avoir chacun leur « Boissons », donc
-- l'étape 3 — qui crée précisément ces doublons volontaires — ne peut pas
-- s'exécuter tant qu'elle tient.
--
-- Rejeu sur données réelles avant correction : `duplicate key value violates
-- unique constraint "Category_nom_key"`. Le rejeu sur base VIERGE passait, lui,
-- sans rien signaler — l'étape 3 n'y insère aucune ligne.
DROP INDEX IF EXISTS "Category_nom_key";

-- ─── 2. Attribution : une catégorie revient au vendeur de ses produits ─────
-- `MIN` est arbitraire mais déterministe ; les autres vendeurs qui partageaient
-- cette catégorie reçoivent leur propre copie à l'étape 3.
UPDATE "Category" c
   SET "restaurantId" = s."restaurantId"
  FROM (
    SELECT "categoryId", MIN("restaurantId") AS "restaurantId"
      FROM "Product"
     WHERE "categoryId" IS NOT NULL
     GROUP BY "categoryId"
  ) s
 WHERE c.id = s."categoryId";

-- ─── 3. Duplication des catégories partagées entre plusieurs vendeurs ──────
-- Table de correspondance explicite : recoller les produits sur leur nouvelle
-- catégorie par le nom serait ambigu dès deux libellés proches.
CREATE TEMP TABLE lilia_cat_split AS
SELECT DISTINCT
       p."categoryId"   AS old_id,
       p."restaurantId" AS resto_id,
       'cat' || substr(md5(p."categoryId" || p."restaurantId"), 1, 22) AS new_id
  FROM "Product" p
  JOIN "Category" c ON c.id = p."categoryId"
 WHERE p."categoryId" IS NOT NULL
   AND p."restaurantId" <> c."restaurantId";

INSERT INTO "Category"
       (id, "nom", "slug", "restaurantId", "description", "imageUrl",
        "displayOrder", "isActive", "createdAt", "updatedAt")
SELECT m.new_id, c."nom", c."slug", m.resto_id, c."description", c."imageUrl",
       c."displayOrder", c."isActive", now(), now()
  FROM lilia_cat_split m
  JOIN "Category" c ON c.id = m.old_id;

UPDATE "Product" p
   SET "categoryId" = m.new_id
  FROM lilia_cat_split m
 WHERE p."categoryId" = m.old_id
   AND p."restaurantId" = m.resto_id;

DROP TABLE lilia_cat_split;

-- ─── 4. Catégories orphelines : aucun produit ne les porte ─────────────────
-- Ce sont des sections abandonnées d'un vendeur, restées dans la taxonomie de
-- toute la plateforme faute de propriétaire. Rien à conserver : aucune ligne
-- métier n'y est rattachée (la condition `restaurantId IS NULL` le garantit,
-- l'étape 2 ayant attribué toutes celles qui portaient au moins un produit).
DELETE FROM "Category" WHERE "restaurantId" IS NULL;

-- ─── 5. Verrouillage du modèle ─────────────────────────────────────────────
ALTER TABLE "Category"
  ALTER COLUMN "restaurantId" SET NOT NULL,
  ALTER COLUMN "slug"         SET NOT NULL;

CREATE UNIQUE INDEX "Category_restaurantId_slug_key"
  ON "Category"("restaurantId", "slug");
-- Cible de la clé étrangère composite de Product (étape 6).
CREATE UNIQUE INDEX "Category_id_restaurantId_key"
  ON "Category"("id", "restaurantId");
CREATE INDEX "Category_restaurantId_displayOrder_idx"
  ON "Category"("restaurantId", "displayOrder");

ALTER TABLE "Category"
  ADD CONSTRAINT "Category_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 6. Isolation garantie par PostgreSQL, pas par un `if` ─────────────────
-- Un produit du vendeur A ne peut plus référencer une catégorie du vendeur B :
-- la jointure porte sur le COUPLE (categoryId, restaurantId).
--
-- `MATCH SIMPLE` (défaut) laisse passer les lignes dont `categoryId` est NULL —
-- c'est voulu : un produit sans catégorie reste parfaitement valide.
--
-- `ON DELETE RESTRICT` et non `SET NULL` : `restaurantId` étant NOT NULL, un
-- SET NULL sur les deux colonnes serait invalide. Le détachement des produits
-- est fait explicitement dans `CategoriesService.remove`, en transaction.
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_categoryId_fkey";
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_categoryId_restaurantId_fkey"
  FOREIGN KEY ("categoryId", "restaurantId")
  REFERENCES "Category"("id", "restaurantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 7. Sections par défaut pour les vendeurs qui n'en ont aucune ──────────
-- Sans cela, un vendeur existant se retrouverait avec une carte vide : le
-- formulaire produit ne proposerait aucune section, donc aucun produit n'en
-- porterait, donc la liste resterait vide. Même jeu que
-- `DEFAULT_CATEGORIES_BY_VENDOR_TYPE` (category.includes.ts).
INSERT INTO "Category"
       (id, "nom", "slug", "restaurantId", "displayOrder", "isActive",
        "createdAt", "updatedAt")
SELECT 'cat' || substr(md5(r.id || d.nom), 1, 22),
       d.nom, lilia_category_slug(d.nom), r.id, d.ord, true, now(), now()
  FROM "Restaurant" r
  JOIN (VALUES
          ('RESTAURANT',    'Plats',           0),
          ('RESTAURANT',    'Accompagnements', 1),
          ('RESTAURANT',    'Boissons',        2),
          ('HOME_COOK',     'Plats',           0),
          ('HOME_COOK',     'Desserts',        1),
          ('BAKERY',        'Pains',           0),
          ('BAKERY',        'Viennoiseries',   1),
          ('BAKERY',        'Pâtisseries',     2),
          ('BEVERAGE_SHOP', 'Sodas',           0),
          ('BEVERAGE_SHOP', 'Jus',             1),
          ('BEVERAGE_SHOP', 'Eaux',            2),
          ('GROCERY',       'Épicerie',        0),
          ('GROCERY',       'Boissons',        1)
       ) AS d(vtype, nom, ord) ON d.vtype = r."vendorType"::text
 WHERE NOT EXISTS (
   SELECT 1 FROM "Category" c
    WHERE c."restaurantId" = r.id
      AND c."slug" = lilia_category_slug(d.nom)
 );

-- ─── 8. Montants du catalogue : Float → Int ────────────────────────────────
-- Le XAF n'a pas de sous-unité. Les DTO imposaient déjà `@IsInt` (fix B-6) ;
-- la colonne restait le dernier endroit où « 1 250,5 FCFA » était
-- représentable. `round()` et non `trunc()` : sur des montants déjà entiers en
-- pratique, c'est équivalent, et sur une valeur héritée à virgule c'est le
-- comportement le moins surprenant.
--
-- Périmètre volontairement limité au catalogue. Les colonnes comptables
-- (Order, Payment, RestaurantPayout, Refund) portent des pièces déjà émises et
-- relèvent d'un chantier distinct (dette M12).
ALTER TABLE "Product"        ALTER COLUMN "prixOriginal" TYPE INTEGER USING round("prixOriginal")::int;
ALTER TABLE "ProductVariant" ALTER COLUMN "prix"         TYPE INTEGER USING round("prix")::int;
ALTER TABLE "MenuDuJour"     ALTER COLUMN "prix"         TYPE INTEGER USING round("prix")::int;
ALTER TABLE "DeliveryZone"   ALTER COLUMN "fee"          TYPE INTEGER USING round("fee")::int;

ALTER TABLE "Restaurant" ALTER COLUMN "fixedDeliveryFee" DROP DEFAULT;
ALTER TABLE "Restaurant" ALTER COLUMN "fixedDeliveryFee" TYPE INTEGER USING round("fixedDeliveryFee")::int;
ALTER TABLE "Restaurant" ALTER COLUMN "fixedDeliveryFee" SET DEFAULT 1000;

ALTER TABLE "Restaurant" ALTER COLUMN "minimumOrderAmount" DROP DEFAULT;
ALTER TABLE "Restaurant" ALTER COLUMN "minimumOrderAmount" TYPE INTEGER USING round("minimumOrderAmount")::int;
ALTER TABLE "Restaurant" ALTER COLUMN "minimumOrderAmount" SET DEFAULT 0;

DROP FUNCTION lilia_category_slug(text);
