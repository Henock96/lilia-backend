-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "menuId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deleteCommande" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "menuId" TEXT;

-- CreateTable
CREATE TABLE "MenuDuJour" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "imageUrl" TEXT,
    "prix" DOUBLE PRECISION NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuDuJour_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuDuJour_restaurantId_idx" ON "MenuDuJour"("restaurantId");
