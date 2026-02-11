-- DropIndex
DROP INDEX "CartItem_cartId_variantId_key";

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cartId_variantId_menuId_key" ON "CartItem"("cartId", "variantId", "menuId");

-- CreateIndex
CREATE INDEX "CartItem_menuId_idx" ON "CartItem"("menuId");
