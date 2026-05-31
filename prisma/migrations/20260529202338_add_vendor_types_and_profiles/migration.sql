-- CreateEnum
CREATE TYPE "VendorType" AS ENUM ('RESTAURANT', 'HOME_COOK', 'BEVERAGE_SHOP', 'BAKERY', 'GROCERY');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('FOOD', 'BEVERAGE', 'ALCOHOL', 'PASTRY', 'GROCERY');

-- CreateEnum
CREATE TYPE "StockMode" AS ENUM ('DAILY', 'PERMANENT');

-- DropIndex
DROP INDEX "Product_description_trgm_idx";

-- DropIndex
DROP INDEX "Product_nom_trgm_idx";

-- DropIndex
DROP INDEX "Restaurant_nom_trgm_idx";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "ageVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ageVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "isPreorder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preorderConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "alcoholContent" DOUBLE PRECISION,
ADD COLUMN     "availableFrom" TEXT,
ADD COLUMN     "availableUntil" TEXT,
ADD COLUMN     "ingredients" TEXT,
ADD COLUMN     "madeToOrder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "productType" "ProductType" NOT NULL DEFAULT 'FOOD',
ADD COLUMN     "shelfLifeDays" INTEGER,
ADD COLUMN     "stockMode" "StockMode" NOT NULL DEFAULT 'DAILY',
ADD COLUMN     "vintage" INTEGER,
ADD COLUMN     "volumeMl" INTEGER;

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "acceptsPreorders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "adminApproved" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "adminApprovedAt" TIMESTAMP(3),
ADD COLUMN     "adminApprovedById" TEXT,
ADD COLUMN     "maxOrdersPerDay" INTEGER,
ADD COLUMN     "minAgeRequired" INTEGER,
ADD COLUMN     "preorderLeadHours" INTEGER,
ADD COLUMN     "vendorType" "VendorType" NOT NULL DEFAULT 'RESTAURANT';

-- CreateTable
CREATE TABLE "VendorProfile" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "story" TEXT,
    "certifications" TEXT[],
    "specialties" TEXT[],
    "licenseNumber" TEXT,
    "nextAvailableSlot" TIMESTAMP(3),
    "productionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorProfile_restaurantId_key" ON "VendorProfile"("restaurantId");

-- CreateIndex
CREATE INDEX "Product_restaurantId_productType_idx" ON "Product"("restaurantId", "productType");

-- CreateIndex
CREATE INDEX "Product_productType_stockMode_idx" ON "Product"("productType", "stockMode");

-- CreateIndex
CREATE INDEX "Restaurant_vendorType_isActive_adminApproved_idx" ON "Restaurant"("vendorType", "isActive", "adminApproved");

-- CreateIndex
CREATE INDEX "Restaurant_vendorType_isOpen_idx" ON "Restaurant"("vendorType", "isOpen");
