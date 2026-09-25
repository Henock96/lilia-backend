-- F3-07 — dette vendeur, versement automatique (interrupteur éteint).
--
-- Additive, à une exception près : la contrainte des montants de reversement
-- est remplacée pour admettre un versement à 0 entièrement absorbé par la
-- dette (`provider = 'NETTING'`, aucun appel au prestataire). La table
-- `restaurant_payouts` est petite : la validation de la nouvelle contrainte
-- sur l'existant est immédiate, et toutes les lignes ont `amount > 0`.

-- CreateEnum
CREATE TYPE "VendorBalanceKind" AS ENUM ('REFUND_CLAWBACK', 'DEBT_SETTLED', 'DEBT_RESTORED', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "VendorBalanceEntry" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kind" "VendorBalanceKind" NOT NULL,
    "amountXaf" INTEGER NOT NULL,
    "orderId" TEXT,
    "refundId" TEXT,
    "payoutId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorBalanceEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorBalanceEntry_refundId_key" ON "VendorBalanceEntry"("refundId");
CREATE UNIQUE INDEX "VendorBalanceEntry_kind_payoutId_key" ON "VendorBalanceEntry"("kind", "payoutId");
CREATE INDEX "VendorBalanceEntry_restaurantId_createdAt_idx" ON "VendorBalanceEntry"("restaurantId", "createdAt");

ALTER TABLE "VendorBalanceEntry" ADD CONSTRAINT "VendorBalanceEntry_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Le signe suit la nature du mouvement : une dette ne s'efface pas par une
-- écriture du mauvais sens.
ALTER TABLE "VendorBalanceEntry" ADD CONSTRAINT "VendorBalanceEntry_sign_matches_kind" CHECK (
  ("kind" = 'REFUND_CLAWBACK' AND "amountXaf" < 0 AND "refundId" IS NOT NULL)
  OR ("kind" = 'DEBT_SETTLED' AND "amountXaf" > 0 AND "payoutId" IS NOT NULL)
  OR ("kind" = 'DEBT_RESTORED' AND "amountXaf" < 0 AND "payoutId" IS NOT NULL)
  OR ("kind" = 'ADJUSTMENT' AND "amountXaf" <> 0 AND "note" IS NOT NULL)
);

-- AlterTable
ALTER TABLE "restaurant_payouts"
  ADD COLUMN "debtDeductionAmount" INTEGER NOT NULL DEFAULT 0,
  ALTER COLUMN "requestedBy" DROP NOT NULL;

ALTER TABLE "restaurant_payouts" ADD CONSTRAINT "restaurant_payouts_debt_deduction_non_negative"
  CHECK ("debtDeductionAmount" >= 0);

-- Un versement à 0 n'existe que s'il est entièrement absorbé par la dette.
ALTER TABLE "restaurant_payouts" DROP CONSTRAINT "restaurant_payouts_amounts_valid";
ALTER TABLE "restaurant_payouts" ADD CONSTRAINT "restaurant_payouts_amounts_valid" CHECK (
  ("amount" > 0 OR ("amount" = 0 AND "provider" = 'NETTING' AND "debtDeductionAmount" > 0))
  AND "grossAmount" >= 0
  AND "commissionAmount" >= 0
);

-- AlterTable
ALTER TABLE "PlatformSettings"
  ADD COLUMN "vendorPayoutAutoEnabled" BOOLEAN NOT NULL DEFAULT false;
