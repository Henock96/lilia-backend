-- F3-11 — Offres boutique financées par le vendeur.
--
-- Principe : cette migration **ne change aucun comportement**. Toutes les
-- colonnes ajoutées ont un défaut neutre (`0`, `NULL`, `false`) : les
-- commandes et reversements existants ne sont pas réécrits, et tant que
-- `vendorOffersEnabled` est éteint, aucune offre n'est créée ni appliquée.
--
-- D8 (26/09/2026) : la commission reste calculée sur le sous-total AVANT la
-- remise vendeur. Rien à migrer : c'est déjà le calcul en place.

-- Nouvelle valeur d'audit, non utilisée dans cette migration (PG interdit
-- d'employer une valeur ajoutée dans la même transaction).
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_OFFER_STOPPED';

-- CreateEnum
CREATE TYPE "VendorOfferKind" AS ENUM ('PERCENT', 'FIXED_THRESHOLD');

-- CreateEnum
CREATE TYPE "VendorOfferStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXHAUSTED', 'ENDED', 'STOPPED_BY_ADMIN');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "vendorFundedDiscountXaf" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vendorOfferId" TEXT;

-- AlterTable
ALTER TABLE "restaurant_payouts" ADD COLUMN     "vendorOfferAmount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PromoCode" ADD COLUMN     "stackableWithVendorOffer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "vendorOffersEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "VendorOffer" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kind" "VendorOfferKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "minSubTotalXaf" INTEGER NOT NULL DEFAULT 0,
    "maxDiscountXaf" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "budgetXaf" INTEGER NOT NULL,
    "spentXaf" INTEGER NOT NULL DEFAULT 0,
    "status" "VendorOfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "budgetWarnedAt" TIMESTAMP(3),
    "stoppedReason" TEXT,
    "stoppedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorOfferRedemption" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "discountXaf" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorOfferRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorOffer_restaurantId_status_idx" ON "VendorOffer"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "VendorOffer_status_endsAt_idx" ON "VendorOffer"("status", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "VendorOfferRedemption_orderId_key" ON "VendorOfferRedemption"("orderId");

-- CreateIndex
CREATE INDEX "VendorOfferRedemption_offerId_idx" ON "VendorOfferRedemption"("offerId");

-- CreateIndex
CREATE INDEX "Order_vendorOfferId_idx" ON "Order"("vendorOfferId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_vendorOfferId_fkey" FOREIGN KEY ("vendorOfferId") REFERENCES "VendorOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOffer" ADD CONSTRAINT "VendorOffer_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOfferRedemption" ADD CONSTRAINT "VendorOfferRedemption_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "VendorOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOfferRedemption" ADD CONSTRAINT "VendorOfferRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Invariants ───────────────────────────────────────────────────────────────
-- Tables neuves : les CHECK sont posés validés d'emblée. Sur "Order", toutes
-- les lignes existantes portent (NULL, 0), qui satisfait la contrainte.

ALTER TABLE "VendorOffer" ADD CONSTRAINT "VendorOffer_budget_valid"
  CHECK ("budgetXaf" > 0 AND "spentXaf" >= 0 AND "spentXaf" <= "budgetXaf");

-- Bornes vendeur (R-11.6, Q2 : hors bornes = refus, pas de validation admin).
ALTER TABLE "VendorOffer" ADD CONSTRAINT "VendorOffer_terms_valid" CHECK (
  "minSubTotalXaf" >= 0
  AND ("maxDiscountXaf" IS NULL OR "maxDiscountXaf" > 0)
  AND (
    ("kind" = 'PERCENT' AND "value" BETWEEN 1 AND 50)
    OR ("kind" = 'FIXED_THRESHOLD' AND "value" > 0 AND "value" * 2 <= "minSubTotalXaf"
        AND "maxDiscountXaf" IS NULL)
  )
);

ALTER TABLE "VendorOffer" ADD CONSTRAINT "VendorOffer_window_valid" CHECK (
  "endsAt" > "startsAt" AND "endsAt" <= "startsAt" + INTERVAL '30 days'
);

ALTER TABLE "VendorOffer" ADD CONSTRAINT "VendorOffer_stop_reason_required" CHECK (
  "status" <> 'STOPPED_BY_ADMIN'
  OR ("stoppedReason" IS NOT NULL AND length(trim("stoppedReason")) > 0)
);

-- R-11.7 : une seule offre active par vendeur à la fois.
CREATE UNIQUE INDEX "VendorOffer_one_active_per_vendor_uq"
  ON "VendorOffer"("restaurantId") WHERE "status" = 'ACTIVE';

ALTER TABLE "VendorOfferRedemption" ADD CONSTRAINT "VendorOfferRedemption_discount_positive"
  CHECK ("discountXaf" > 0);

ALTER TABLE "Order" ADD CONSTRAINT "Order_vendor_offer_consistent" CHECK (
  "vendorFundedDiscountXaf" >= 0
  AND "vendorFundedDiscountXaf" <= "subTotal"
  AND (("vendorOfferId" IS NULL) = ("vendorFundedDiscountXaf" = 0))
);

ALTER TABLE "restaurant_payouts" ADD CONSTRAINT "restaurant_payouts_vendor_offer_non_negative"
  CHECK ("vendorOfferAmount" >= 0);

-- Les termes d'une offre sont immuables dès qu'une commande l'a utilisée :
-- une commande d'hier doit pouvoir se relire contre l'offre qui l'a remisée.
-- Le vendeur termine l'offre et en crée une autre. Seuls restent modifiables
-- le statut (pause, fin), l'échéance (avancée seulement, cf. service) et le
-- compteur de budget.
CREATE FUNCTION "f311_vendor_offer_terms_immutable"() RETURNS trigger AS $$
BEGIN
  IF (NEW."kind", NEW."value", NEW."minSubTotalXaf", NEW."maxDiscountXaf",
      NEW."budgetXaf", NEW."startsAt", NEW."restaurantId")
     IS DISTINCT FROM
     (OLD."kind", OLD."value", OLD."minSubTotalXaf", OLD."maxDiscountXaf",
      OLD."budgetXaf", OLD."startsAt", OLD."restaurantId")
     AND EXISTS (SELECT 1 FROM "VendorOfferRedemption" r WHERE r."offerId" = OLD.id)
  THEN
    RAISE EXCEPTION 'Les termes de l''offre % sont immuables : elle a déjà servi', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'VendorOffer_terms_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VendorOffer_terms_immutable"
  BEFORE UPDATE ON "VendorOffer"
  FOR EACH ROW EXECUTE FUNCTION "f311_vendor_offer_terms_immutable"();
