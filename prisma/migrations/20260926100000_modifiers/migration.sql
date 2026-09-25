-- F3-09 — Options & suppléments.
--
-- Additive, sauf l'identité des lignes de panier (index unique élargi à
-- `optionsSignature`). Aucune donnée existante n'est réécrite :
--   - `CartItem.optionsSignature` vaut '' par défaut : toute ligne existante
--     est « sans option », et les lignes restent uniques puisque l'ancien
--     index garantissait déjà l'unicité sur un sous-ensemble des colonnes ;
--   - `OrderItem.optionsTotalXaf` vaut 0 : aucune commande passée n'en avait.
--
-- Invariants posés en base (et pas seulement dans les services) : M-1 à M-7
-- de la découverte, plus les bornes de signature. Voir
-- `test/integration/modifiers-schema.int-spec.ts`.

-- ── Colonnes ────────────────────────────────────────────────────────────────

ALTER TABLE "CartItem" ADD COLUMN "optionsSignature" TEXT NOT NULL DEFAULT '';

ALTER TABLE "OrderItem" ADD COLUMN "optionsTotalXaf" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PlatformSettings"
  ADD COLUMN "modifiersEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "modifiersManagementEnabled" BOOLEAN NOT NULL DEFAULT false;

-- ── Identité d'une ligne de panier ─────────────────────────────────────────
-- Les deux index sont remplacés dans la même transaction de migration : il
-- n'existe aucun instant où deux lignes identiques pourraient s'insérer.

DROP INDEX "CartItem_cartId_variantId_menuId_key";
DROP INDEX "CartItem_cartId_variantId_individual_key";

-- L'index partiel est celui qui protège réellement les produits individuels
-- (`NULL != NULL` rend le suivant inopérant quand `menuId` est nul).
CREATE UNIQUE INDEX "CartItem_cartId_variantId_options_individual_key"
  ON "CartItem"("cartId", "variantId", "optionsSignature")
  WHERE "menuId" IS NULL;

-- CreateTable
CREATE TABLE "ModifierGroup" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierOption" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDeltaXaf" INTEGER NOT NULL DEFAULT 0,
    "maxQuantity" INTEGER NOT NULL DEFAULT 1,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModifierOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductModifierGroup" (
    "productId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductModifierGroup_pkey" PRIMARY KEY ("productId","groupId")
);

-- CreateTable
CREATE TABLE "CartItemOption" (
    "cartItemId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CartItemOption_pkey" PRIMARY KEY ("cartItemId","optionId")
);

-- CreateTable
CREATE TABLE "OrderItemOption" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "optionId" TEXT,
    "groupId" TEXT,
    "groupName" TEXT NOT NULL,
    "optionName" TEXT NOT NULL,
    "priceDeltaXaf" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItemOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModifierGroup_restaurantId_deletedAt_displayOrder_idx" ON "ModifierGroup"("restaurantId", "deletedAt", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierGroup_id_restaurantId_key" ON "ModifierGroup"("id", "restaurantId");

-- CreateIndex
CREATE INDEX "ModifierOption_groupId_deletedAt_displayOrder_idx" ON "ModifierOption"("groupId", "deletedAt", "displayOrder");

-- CreateIndex
CREATE INDEX "ProductModifierGroup_groupId_idx" ON "ProductModifierGroup"("groupId");

-- CreateIndex
CREATE INDEX "ProductModifierGroup_restaurantId_idx" ON "ProductModifierGroup"("restaurantId");

-- CreateIndex
CREATE INDEX "CartItemOption_optionId_idx" ON "CartItemOption"("optionId");

-- CreateIndex
CREATE INDEX "OrderItemOption_orderItemId_idx" ON "OrderItemOption"("orderItemId");

-- CreateIndex
CREATE INDEX "OrderItemOption_optionId_idx" ON "OrderItemOption"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cartId_variantId_menuId_optionsSignature_key" ON "CartItem"("cartId", "variantId", "menuId", "optionsSignature");

-- CreateIndex
CREATE UNIQUE INDEX "Product_id_restaurantId_key" ON "Product"("id", "restaurantId");

-- AddForeignKey
ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_productId_restaurantId_fkey" FOREIGN KEY ("productId", "restaurantId") REFERENCES "Product"("id", "restaurantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_groupId_restaurantId_fkey" FOREIGN KEY ("groupId", "restaurantId") REFERENCES "ModifierGroup"("id", "restaurantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItemOption" ADD CONSTRAINT "CartItemOption_cartItemId_fkey" FOREIGN KEY ("cartItemId") REFERENCES "CartItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItemOption" ADD CONSTRAINT "CartItemOption_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ModifierOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ModifierOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Invariants (CHECK) ──────────────────────────────────────────────────────

-- M-1 : cardinalités cohérentes. `maxSelect <= 20` : une ligne ne porte pas
-- plus de 20 options distinctes (Q8), un groupe ne peut donc pas en exiger plus.
ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_select_bounds_chk"
  CHECK ("minSelect" >= 0 AND "maxSelect" >= 1 AND "minSelect" <= "maxSelect" AND "maxSelect" <= 20);
ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_name_chk"
  CHECK (char_length(btrim("name")) BETWEEN 1 AND 80);

-- M-2 : une option ne baisse jamais le prix (R-09.6) ; borne haute = prix max
-- d'un produit (`MAX_PRIX_XAF`).
ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_price_delta_chk"
  CHECK ("priceDeltaXaf" >= 0 AND "priceDeltaXaf" <= 10000000);
-- M-3 : quantité maximale par option.
ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_max_quantity_chk"
  CHECK ("maxQuantity" BETWEEN 1 AND 10);
ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_name_chk"
  CHECK (char_length(btrim("name")) BETWEEN 1 AND 80);

ALTER TABLE "CartItemOption" ADD CONSTRAINT "CartItemOption_quantity_chk"
  CHECK ("quantity" BETWEEN 1 AND 10);

-- M-4 : le figé d'une option de commande.
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_values_chk"
  CHECK ("quantity" >= 1 AND "priceDeltaXaf" >= 0);

-- M-5 : la part des options est positive et **incluse** dans le prix unitaire
-- (décision Q1) — elle ne peut donc pas le dépasser.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_options_total_chk"
  CHECK ("optionsTotalXaf" >= 0 AND "optionsTotalXaf" <= "prix");

-- M-6 : une ligne de menu ne porte pas d'option (R-09.6). Signature bornée :
-- 20 options × (identifiant ≤ 40 + ":10") + séparateurs < 1000.
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_menu_without_options"
  CHECK ("menuId" IS NULL OR "optionsSignature" = '');
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_options_signature_len_chk"
  CHECK (char_length("optionsSignature") <= 1000);

-- M-7 : même vendeur pour le produit et le groupe — porté par les deux FK
-- composites de "ProductModifierGroup" ci-dessus.

-- Ordre de déploiement : l'éditeur vendeur n'est ouvert que si la plateforme
-- vend des options (voir `PlatformSettingsService.updateSettings`).
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_modifiers_rollout_chk"
  CHECK ("modifiersManagementEnabled" = false OR "modifiersEnabled" = true);
