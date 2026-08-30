-- Deux correctifs de contraintes relevés par l'audit du 28/08/2026.

-- ── L9 : unicité réelle des lignes de panier individuelles ──────────────────
-- `CartItem @@unique([cartId, variantId, menuId])` ne protège PAS les lignes
-- `menuId = NULL` : en PostgreSQL, NULL != NULL, donc deux lignes identiques
-- sur (cartId, variantId) avec menuId NULL passent la contrainte. Or c'est le
-- cas le PLUS fréquent (produit ajouté hors menu) : le `findFirst` puis
-- `create` du service, joués en concurrence, créaient deux lignes pour le même
-- produit. Prisma ne sait pas déclarer un index partiel — d'où ce SQL manuel.
--
-- Dédoublonnage préalable, sinon la création de l'index échoue : on garde la
-- ligne la plus ancienne de chaque doublon et on lui additionne les quantités
-- des autres.
WITH ranked AS (
  SELECT id,
         "cartId",
         "variantId",
         quantite,
         ROW_NUMBER() OVER (
           PARTITION BY "cartId", "variantId"
           ORDER BY "createdAt", id
         ) AS rn
    FROM "CartItem"
   WHERE "menuId" IS NULL
),
survivors AS (
  SELECT "cartId", "variantId",
         MIN(id) FILTER (WHERE rn = 1) AS keep_id,
         SUM(quantite)                 AS total_quantite
    FROM ranked
   GROUP BY "cartId", "variantId"
  HAVING COUNT(*) > 1
)
UPDATE "CartItem" ci
   SET quantite = LEAST(s.total_quantite, 50) -- MAX_ITEM_QUANTITY côté DTO
  FROM survivors s
 WHERE ci.id = s.keep_id;

DELETE FROM "CartItem"
 WHERE "menuId" IS NULL
   AND id IN (
     SELECT id FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY "cartId", "variantId"
                ORDER BY "createdAt", id
              ) AS rn
         FROM "CartItem"
        WHERE "menuId" IS NULL
     ) d
     WHERE d.rn > 1
   );

CREATE UNIQUE INDEX "CartItem_cartId_variantId_individual_key"
  ON "CartItem"("cartId", "variantId")
  WHERE "menuId" IS NULL;

-- ── L10 : défaut sûr pour l'approbation vendeur ─────────────────────────────
-- `Restaurant.adminApproved` valait `true` par défaut ; la règle « false hors
-- RESTAURANT » ne vivait que dans les services. Toute création contournant ces
-- services (script, seed, futur endpoint) publiait donc un vendeur non validé.
-- Les trois chemins de création posent maintenant la valeur explicitement.
-- Les lignes existantes ne sont PAS touchées : les vendeurs déjà approuvés le
-- restent.
ALTER TABLE "Restaurant" ALTER COLUMN "adminApproved" SET DEFAULT false;
