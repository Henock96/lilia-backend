-- F3-05 — échec de livraison et responsabilité. Additive : colonnes
-- nullables, types et table neufs. L'ancien code tourne dessus.

CREATE TYPE "DeliveryFailureReason" AS ENUM (
  'CUSTOMER_UNREACHABLE', 'ADDRESS_NOT_FOUND', 'CUSTOMER_REFUSED',
  'ACCIDENT', 'LOST_OR_DAMAGED', 'DRIVER_NO_SHOW', 'OTHER'
);
CREATE TYPE "FailureLiability" AS ENUM ('CLIENT', 'DRIVER', 'VENDOR', 'PLATFORM');

ALTER TABLE "Order"
  ADD COLUMN "failedAt" TIMESTAMP(3),
  ADD COLUMN "failureReason" "DeliveryFailureReason",
  ADD COLUMN "failureLiability" "FailureLiability",
  ADD COLUMN "failureDecidedBy" TEXT;

ALTER TABLE "Delivery" ADD COLUMN "failedAt" TIMESTAMP(3);

CREATE TABLE "DeliveryFailureReport" (
  "id" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "reportedBy" TEXT NOT NULL,
  "reportedByRole" TEXT NOT NULL,
  "reason" "DeliveryFailureReason",
  "note" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "distanceToDestM" INTEGER,
  "callAttempts" INTEGER NOT NULL DEFAULT 0,
  "smsSentAt" TIMESTAMP(3),
  "protocolStartedAt" TIMESTAMP(3),
  "declaredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeliveryFailureReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeliveryFailureReport_callAttempts_chk" CHECK ("callAttempts" >= 0)
);

CREATE INDEX "DeliveryFailureReport_orderId_idx" ON "DeliveryFailureReport"("orderId");
CREATE INDEX "DeliveryFailureReport_deliveryId_declaredAt_idx"
  ON "DeliveryFailureReport"("deliveryId", "declaredAt");

ALTER TABLE "DeliveryFailureReport"
  ADD CONSTRAINT "DeliveryFailureReport_deliveryId_fkey" FOREIGN KEY ("deliveryId")
  REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Un échec conclu porte son responsable : pas d'ECHEC_LIVRAISON sans lui.
-- Toutes les lignes existantes le respectent (aucune n'est en ECHEC_LIVRAISON).
ALTER TABLE "Order" ADD CONSTRAINT "Order_failure_liability_chk"
  CHECK ("status" <> 'ECHEC_LIVRAISON' OR "failureLiability" IS NOT NULL) NOT VALID;
