-- F3-10 — Stock multi-unités, politique de stock explicite.
--
-- Principe : cette migration **reproduit le comportement actuel à
-- l'identique**. Toutes les consommations valent 1 (le calcul
-- `Σ quantite × stockConsumption` est alors exactement l'ancien `Σ quantite`),
-- la politique est déduite des colonnes existantes, et les commandes déjà
-- passées gardent `stockUnits*` à NULL (= ancienne règle de restitution).
-- Aucune donnée n'est inventée.

-- ── Types ───────────────────────────────────────────────────────────────────

CREATE TYPE "StockPolicy" AS ENUM ('UNLIMITED', 'DAILY_QUOTA', 'INVENTORY');
CREATE TYPE "StockUnit" AS ENUM ('PIECE', 'PORTION', 'BOTTLE', 'CAN', 'CUP', 'BAG');

-- ── Colonnes (métadonnée seule en PG ≥ 11 : aucune réécriture de table) ──────

ALTER TABLE "Product"
  ADD COLUMN "stockPolicy" "StockPolicy" NOT NULL DEFAULT 'UNLIMITED',
  ADD COLUMN "stockUnit" "StockUnit" NOT NULL DEFAULT 'PIECE',
  ADD COLUMN "stockResetAt" TIMESTAMP(3);

ALTER TABLE "ProductVariant"
  ADD COLUMN "stockConsumption" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "OrderItem"
  ADD COLUMN "stockUnitsPerItem" INTEGER,
  ADD COLUMN "stockUnitsReserved" INTEGER,
  ADD COLUMN "stockUnit" "StockUnit";

ALTER TABLE "PlatformSettings"
  ADD COLUMN "multiUnitVariantsEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MenuProduct" ADD COLUMN "variantId" TEXT;

-- ── Politique déduite de l'existant ──────────────────────────────────────────
-- « illimité » = aucun compteur. Un produit qui n'a qu'une des deux colonnes
-- renseignée (incohérence préexistante) garde un compteur : il est limité par
-- `stockRestant`, exactement comme le décrément le traitait déjà.

-- Incohérence préexistante : capacité déclarée sans compteur. Le décrément et
-- le panier ne lisent que `stockRestant` :
--  - en DAILY, le prochain reset de 5 h allait poser `stockRestant = quota` :
--    on applique ce reset maintenant (quelques heures d'avance, rien d'inventé) ;
--  - en PERMANENT, aucun reset ne viendrait jamais : le produit se vendait et
--    se serait vendu sans limite → il est dit illimité, tel quel.
UPDATE "Product" SET "stockRestant" = "stockQuotidien"
 WHERE "stockRestant" IS NULL AND "stockQuotidien" IS NOT NULL AND "stockMode" = 'DAILY';
UPDATE "Product" SET "stockQuotidien" = NULL
 WHERE "stockRestant" IS NULL AND "stockQuotidien" IS NOT NULL;

UPDATE "Product" SET "stockPolicy" = CASE
    WHEN "stockRestant" IS NULL THEN 'UNLIMITED'
    WHEN "stockMode" = 'DAILY' AND "stockQuotidien" IS NOT NULL THEN 'DAILY_QUOTA'
    ELSE 'INVENTORY'
  END::"StockPolicy";

-- Dernier reset réellement passé : aujourd'hui 4 h UTC (cron `0 4 * * *`), ou
-- hier si l'on migre avant 4 h. Poser `now()` empêcherait de restituer les
-- commandes réservées ce matin et annulées après le déploiement.
UPDATE "Product" SET "stockResetAt" =
    date_trunc('day', timezone('UTC', now())) + interval '4 hours'
  - CASE WHEN timezone('UTC', now()) < date_trunc('day', timezone('UTC', now())) + interval '4 hours'
         THEN interval '1 day' ELSE interval '0' END
 WHERE "stockPolicy" = 'DAILY_QUOTA';

-- ── Composant de menu : la variante que les catalogues affichent déjà ────────
-- Même ordre que `MENU_VARIANTS_ORDER_BY` (prix croissant, puis id). Toutes
-- les consommations valant 1, aucun comportement ne change.

UPDATE "MenuProduct" mp SET "variantId" = (
  SELECT v.id FROM "ProductVariant" v
   WHERE v."productId" = mp."productId"
   ORDER BY v.prix ASC, v.id ASC
   LIMIT 1);

-- Un composant sans aucune variante n'était pas commandable (`addMenu` levait
-- « n'a pas de variante disponible ») : on lui en donne une « Standard », au
-- prix du produit, comme `ProductCommandService.create` le fait par défaut.
INSERT INTO "ProductVariant" (id, label, prix, "productId", "createdAt", "updatedAt")
SELECT 'f310-' || p.id, 'Standard', p."prixOriginal", p.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "Product" p
 WHERE EXISTS (SELECT 1 FROM "MenuProduct" mp WHERE mp."productId" = p.id AND mp."variantId" IS NULL);

UPDATE "MenuProduct" mp SET "variantId" = 'f310-' || mp."productId"
 WHERE mp."variantId" IS NULL;

ALTER TABLE "MenuProduct" ALTER COLUMN "variantId" SET NOT NULL;

-- ── Clés étrangères composites : la variante appartient au produit ───────────

CREATE UNIQUE INDEX "ProductVariant_id_productId_key"
  ON "ProductVariant"("id", "productId");

ALTER TABLE "MenuProduct" ADD CONSTRAINT "MenuProduct_variantId_productId_fkey"
  FOREIGN KEY ("variantId", "productId") REFERENCES "ProductVariant"("id", "productId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Remplace la FK simple : même comportement (RESTRICT), plus l'appartenance.
ALTER TABLE "CartItem" DROP CONSTRAINT "CartItem_variantId_fkey";
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_productId_fkey"
  FOREIGN KEY ("variantId", "productId") REFERENCES "ProductVariant"("id", "productId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CartItem" VALIDATE CONSTRAINT "CartItem_variantId_productId_fkey";

CREATE INDEX "Product_stockPolicy_idx" ON "Product"("stockPolicy");

-- ── Invariants ───────────────────────────────────────────────────────────────

-- Politique ↔ compteurs : ne peuvent pas se contredire.
ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_policy_consistent" CHECK (
  ("stockQuotidien" IS NULL OR "stockQuotidien" >= 0)
  AND CASE "stockPolicy"
    WHEN 'UNLIMITED'   THEN "stockRestant" IS NULL AND "stockQuotidien" IS NULL
    WHEN 'DAILY_QUOTA' THEN "stockRestant" IS NOT NULL AND "stockQuotidien" IS NOT NULL
    ELSE                    "stockRestant" IS NOT NULL
  END
) NOT VALID;
ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_stock_policy_consistent";

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_stock_consumption_range"
  CHECK ("stockConsumption" BETWEEN 1 AND 1000);

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_stock_units_valid" CHECK (
  ("stockUnitsPerItem" IS NULL OR "stockUnitsPerItem" >= 1)
  AND ("stockUnitsReserved" IS NULL OR (
        "stockUnitsReserved" >= 0
    AND "stockUnitsReserved" <= "quantite" * COALESCE("stockUnitsPerItem", 1)))
);

-- La consommation d'un format est immuable : changer « carton de 6 » en
-- « carton de 12 » en place rendrait faux les paniers, obligerait le checkout
-- à verrouiller la variante (ordre inverse des écritures vendeur → risque
-- d'interblocage) et ferait mentir le reorder. On crée un autre format.
CREATE FUNCTION "f310_stock_consumption_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."stockConsumption" IS DISTINCT FROM OLD."stockConsumption" THEN
    RAISE EXCEPTION 'ProductVariant.stockConsumption est immuable (variante %)', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ProductVariant_stock_consumption_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProductVariant_stock_consumption_immutable"
  BEFORE UPDATE OF "stockConsumption" ON "ProductVariant"
  FOR EACH ROW EXECUTE FUNCTION "f310_stock_consumption_immutable"();

-- Les CHECK de stock posés NOT VALID le 23/09 : les lignes existantes n'ont
-- jamais été contrôlées. On les valide maintenant (verrou léger
-- SHARE UPDATE EXCLUSIVE) — elles portent sur les colonnes que F3-10 lit.
ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_price_stock_non_negative";
ALTER TABLE "MenuDuJour" VALIDATE CONSTRAINT "MenuDuJour_price_stock_non_negative";
ALTER TABLE "CartItem" VALIDATE CONSTRAINT "CartItem_quantity_positive";
ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_quantity_price_valid";
ALTER TABLE "ProductVariant" VALIDATE CONSTRAINT "ProductVariant_price_non_negative";
