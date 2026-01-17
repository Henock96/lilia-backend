-- CreateEnum
CREATE TYPE "DeliveryPriceMode" AS ENUM ('FIXED', 'ZONE_BASED');

-- AlterTable
ALTER TABLE "Adresses" ADD COLUMN     "quartierId" TEXT;

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "deliveryPriceMode" "DeliveryPriceMode" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "fixedDeliveryFee" DOUBLE PRECISION NOT NULL DEFAULT 500;

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "zoneName" TEXT NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quartier" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "ville" TEXT NOT NULL DEFAULT 'Brazzaville',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quartier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuartierZone" (
    "id" TEXT NOT NULL,
    "quartierId" TEXT NOT NULL,
    "deliveryZoneId" TEXT NOT NULL,

    CONSTRAINT "QuartierZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryZone_restaurantId_idx" ON "DeliveryZone"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Quartier_nom_key" ON "Quartier"("nom");

-- CreateIndex
CREATE INDEX "QuartierZone_quartierId_idx" ON "QuartierZone"("quartierId");

-- CreateIndex
CREATE INDEX "QuartierZone_deliveryZoneId_idx" ON "QuartierZone"("deliveryZoneId");

-- CreateIndex
CREATE UNIQUE INDEX "QuartierZone_quartierId_deliveryZoneId_key" ON "QuartierZone"("quartierId", "deliveryZoneId");

-- CreateIndex
CREATE INDEX "Adresses_quartierId_idx" ON "Adresses"("quartierId");
