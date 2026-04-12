-- CreateEnum
CREATE TYPE "OrderLifecycleStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'READY', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('AVAILABLE', 'ON_DELIVERY', 'OFFLINE');

-- CreateEnum
CREATE TYPE "StatusUser" AS ENUM ('INACTIVE', 'ACTIVE', 'BLOCKED');

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "itemKey" TEXT;

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "estimatedArrival" TIMESTAMP(3),
ADD COLUMN     "lastLatitude" DOUBLE PRECISION,
ADD COLUMN     "lastLongitude" DOUBLE PRECISION,
ADD COLUMN     "lastPositionAt" TIMESTAMP(3),
ADD COLUMN     "pickedUpAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryLatitude" DOUBLE PRECISION,
ADD COLUMN     "deliveryLongitude" DOUBLE PRECISION,
ADD COLUMN     "deliveryQuartierId" TEXT,
ADD COLUMN     "lifecycleStatus" "OrderLifecycleStatus",
ADD COLUMN     "serviceFee" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "snapshotPrice" DOUBLE PRECISION,
ADD COLUMN     "variantId" TEXT,
ADD COLUMN     "variantLabel" TEXT;

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ALTER COLUMN "fixedDeliveryFee" SET DEFAULT 1000;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "driverStatus" "DriverStatus",
ADD COLUMN     "statusUser" "StatusUser" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "OrderHistory" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "OrderStatus" NOT NULL,
    "toStatus" "OrderStatus" NOT NULL,
    "actionId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryLocation" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderHistory_orderId_idx" ON "OrderHistory"("orderId");

-- CreateIndex
CREATE INDEX "DeliveryLocation_deliveryId_recordedAt_idx" ON "DeliveryLocation"("deliveryId", "recordedAt");

-- CreateIndex
CREATE INDEX "CartItem_cartId_itemKey_idx" ON "CartItem"("cartId", "itemKey");

-- CreateIndex
CREATE INDEX "Delivery_status_idx" ON "Delivery"("status");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_lifecycleStatus_idx" ON "Order"("lifecycleStatus");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");
