-- Phase 3, F3-02 — tarification de la livraison par la plateforme.
--
-- Le vendeur fixait le prix de la course (`fixedDeliveryFee`, zones), qui est
-- aussi l'assiette de la paie livreur : un vendeur à 0 XAF faisait rouler un
-- livreur indépendant gratuitement (finding F-05). La plateforme publie
-- désormais une grille ; le vendeur peut seulement OFFRIR une part du prix,
-- déduite de son reversement.
--
-- Entièrement additive. `deliveryPricingMode = VENDOR_LEGACY` : rien ne change
-- tant qu'une grille n'est pas publiée ET le mode basculé. Les colonnes
-- vendeur historiques restent en place (retour arrière = repasser le mode).
--
-- ⚠️ `migrate diff` proposait aussi `DROP INDEX "Refund_status_provider_idx"` :
-- dérive préexistante entre migrations et schéma, hors de propos ici — retirée.

-- CreateEnum
CREATE TYPE "DeliveryPricingMode" AS ENUM ('VENDOR_LEGACY', 'PLATFORM');

-- CreateEnum
CREATE TYPE "DeliverySubsidyMode" AS ENUM ('NONE', 'FIXED', 'FREE_ABOVE');

-- CreateEnum
CREATE TYPE "DeliveryTariffStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');


-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryDistanceKm" DOUBLE PRECISION,
ADD COLUMN     "deliveryFeeBaseXaf" INTEGER,
ADD COLUMN     "deliveryTariffVersion" INTEGER,
ADD COLUMN     "vendorDeliverySubsidyXaf" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "deliveryPricingMode" "DeliveryPricingMode" NOT NULL DEFAULT 'VENDOR_LEGACY';

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "deliverySubsidyMode" "DeliverySubsidyMode" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "deliverySubsidyXaf" INTEGER,
ADD COLUMN     "freeDeliveryThresholdXaf" INTEGER;

-- CreateTable
CREATE TABLE "DeliveryTariff" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DeliveryTariffStatus" NOT NULL DEFAULT 'DRAFT',
    "roadFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.3,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryTariff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryTariffBand" (
    "id" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "maxKm" DOUBLE PRECISION NOT NULL,
    "feeXaf" INTEGER NOT NULL,

    CONSTRAINT "DeliveryTariffBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryTariffOverride" (
    "id" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "originQuartierId" TEXT NOT NULL,
    "destQuartierId" TEXT NOT NULL,
    "feeXaf" INTEGER NOT NULL,

    CONSTRAINT "DeliveryTariffOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTariff_version_key" ON "DeliveryTariff"("version");

-- CreateIndex
CREATE INDEX "DeliveryTariff_status_idx" ON "DeliveryTariff"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTariffBand_tariffId_maxKm_key" ON "DeliveryTariffBand"("tariffId", "maxKm");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTariffOverride_tariffId_originQuartierId_destQuarti_key" ON "DeliveryTariffOverride"("tariffId", "originQuartierId", "destQuartierId");

-- AddForeignKey
ALTER TABLE "DeliveryTariffBand" ADD CONSTRAINT "DeliveryTariffBand_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "DeliveryTariff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryTariffOverride" ADD CONSTRAINT "DeliveryTariffOverride_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "DeliveryTariff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryTariffOverride" ADD CONSTRAINT "DeliveryTariffOverride_originQuartierId_fkey" FOREIGN KEY ("originQuartierId") REFERENCES "Quartier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryTariffOverride" ADD CONSTRAINT "DeliveryTariffOverride_destQuartierId_fkey" FOREIGN KEY ("destQuartierId") REFERENCES "Quartier"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Une seule grille en vigueur à la fois : la base arbitre deux publications
-- simultanées, pas un `if`.
CREATE UNIQUE INDEX "DeliveryTariff_one_published_uq" ON "DeliveryTariff"("status") WHERE "status" = 'PUBLISHED';

-- Bornes : un prix négatif ou une tranche de 0 km n'ont pas de sens.
ALTER TABLE "DeliveryTariff" ADD CONSTRAINT "DeliveryTariff_road_factor_bounds" CHECK ("roadFactor" >= 1 AND "roadFactor" <= 3);
ALTER TABLE "DeliveryTariffBand" ADD CONSTRAINT "DeliveryTariffBand_bounds" CHECK ("maxKm" > 0 AND "feeXaf" >= 0);
ALTER TABLE "DeliveryTariffOverride" ADD CONSTRAINT "DeliveryTariffOverride_fee_non_negative" CHECK ("feeXaf" >= 0);
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_delivery_subsidy_non_negative" CHECK (
  ("deliverySubsidyXaf" IS NULL OR "deliverySubsidyXaf" >= 0)
  AND ("freeDeliveryThresholdXaf" IS NULL OR "freeDeliveryThresholdXaf" >= 0)
) NOT VALID;
-- La subvention ne dépasse jamais le prix de base qu'elle réduit.
ALTER TABLE "Order" ADD CONSTRAINT "Order_delivery_subsidy_bounds" CHECK (
  "vendorDeliverySubsidyXaf" >= 0
  AND ("deliveryFeeBaseXaf" IS NULL OR "deliveryFeeBaseXaf" >= 0)
  AND ("deliveryFeeBaseXaf" IS NULL OR "vendorDeliverySubsidyXaf" <= "deliveryFeeBaseXaf")
) NOT VALID;
