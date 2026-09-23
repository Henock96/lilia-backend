-- Phase 3, F3-01 — acceptation vendeur : colonnes et paramètres.
--
-- Entièrement additive : colonnes nullables ou avec défaut, aucune réécriture.
-- L'ancien code tourne dessus sans changement.
--
-- `acceptDeadlineAt` reste NULL sur l'historique : le balayage d'expiration ne
-- regarde que les lignes où elle est posée, aucune commande passée ne peut
-- donc être annulée rétroactivement.
--
-- `orderAcceptanceRequired = false` : rien ne change de comportement tant
-- que l'interrupteur n'est pas basculé, après publication des applications.

-- CreateEnum
CREATE TYPE "VendorRejectionReason" AS ENUM ('OUT_OF_STOCK', 'TOO_BUSY', 'CLOSING', 'OUT_OF_ZONE', 'OTHER');

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "acceptDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "estimatedReadyAt" TIMESTAMP(3),
  ADD COLUMN "vendorRejectionReason" "VendorRejectionReason",
  ADD COLUMN "vendorRejectionNote" TEXT;

-- AlterTable
ALTER TABLE "PlatformSettings"
  ADD COLUMN "orderAcceptanceRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "vendorAcceptanceTimeoutMinutes" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN "vendorAcceptanceReminderLeadMinutes" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "preorderAcceptanceHours" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "autoRefundVendorFault" BOOLEAN NOT NULL DEFAULT true;

-- Bornes : un délai nul ou négatif annulerait toute commande à la seconde où
-- elle est payée. NOT VALID inutile : la table n'a qu'une ligne, aux défauts.
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_acceptance_bounds" CHECK (
  "vendorAcceptanceTimeoutMinutes" BETWEEN 2 AND 60
  AND "vendorAcceptanceReminderLeadMinutes" BETWEEN 0 AND 30
  AND "vendorAcceptanceReminderLeadMinutes" < "vendorAcceptanceTimeoutMinutes"
  AND "preorderAcceptanceHours" BETWEEN 1 AND 48
);

-- CreateIndex
CREATE INDEX "Order_status_acceptDeadlineAt_idx" ON "Order"("status", "acceptDeadlineAt");
