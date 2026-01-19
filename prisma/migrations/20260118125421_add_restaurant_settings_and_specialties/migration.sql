-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "estimatedDeliveryTimeMax" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "estimatedDeliveryTimeMin" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "isOpen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "minimumOrderAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Specialty" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Specialty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Specialty_restaurantId_idx" ON "Specialty"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Specialty_restaurantId_name_key" ON "Specialty"("restaurantId", "name");
