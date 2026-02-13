-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI', 'DIMANCHE');

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "manualOverride" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OperatingHours" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "openTime" TEXT NOT NULL,
    "closeTime" TEXT NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatingHours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperatingHours_restaurantId_idx" ON "OperatingHours"("restaurantId");

-- CreateIndex
CREATE INDEX "OperatingHours_dayOfWeek_idx" ON "OperatingHours"("dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "OperatingHours_restaurantId_dayOfWeek_key" ON "OperatingHours"("restaurantId", "dayOfWeek");
