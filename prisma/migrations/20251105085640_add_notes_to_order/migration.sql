-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "notes" TEXT;

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");
