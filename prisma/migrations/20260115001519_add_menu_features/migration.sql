/*
  Warnings:

  - Added the required column `dateDebut` to the `MenuDuJour` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dateFin` to the `MenuDuJour` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "MenuDuJour" ADD COLUMN     "dateDebut" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "dateFin" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "MenuProduct" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ordre" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuProduct_menuId_idx" ON "MenuProduct"("menuId");

-- CreateIndex
CREATE INDEX "MenuProduct_productId_idx" ON "MenuProduct"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuProduct_menuId_productId_key" ON "MenuProduct"("menuId", "productId");

-- CreateIndex
CREATE INDEX "MenuDuJour_dateDebut_dateFin_idx" ON "MenuDuJour"("dateDebut", "dateFin");
