-- ════════════════════════════════════════════════════════════════════════════
-- RÈGLEMENT DU LIVREUR — 19 septembre 2026
--
-- Registre de ce que Lilia Food a VERSÉ à ses livreurs. Aucun virement n'est
-- déclenché par cette table : le versement se fait hors application (décision
-- D-6). Le rail automatique est éteint en production (PAYMENT_MODE=MANUAL,
-- ManualProvider.supportsPayout = false), la capacité PAYOUT de pawaPay n'a
-- jamais été validée, et aucun livreur n'a de compte de versement enregistré.
--
-- ENREGISTRÉ EN UN TEMPS : la ligne n'est écrite qu'APRÈS remise de l'argent.
-- Pas d'état d'attente — un « en cours » aurait décrit un moment qui n'existe
-- pas ici, et son vrai effet aurait été de verrouiller les courses d'un livreur
-- si personne ne revenait le confirmer.
--
-- ⚠️ `Delivery.driverSettlementId` est ce qui interdit de payer deux fois la
-- même course. C'est la BASE qui arbitre, via un
-- `updateMany WHERE driverSettlementId IS NULL` dans la transaction — pas un
-- contrôle applicatif. Même raisonnement que `@@unique([orderId])` sur
-- `restaurant_payouts`.
--
-- ENTIÈREMENT ADDITIVE. Aucun backfill : les 26 courses antérieures au
-- 18/09/2026 n'ont aucune économie enregistrée et restent hors registre
-- (décision du 19/09). Les faire apparaître créerait une dette fictive.
--
-- ⚠️ ORDRE : les types AVANT les colonnes, la table AVANT sa clé étrangère.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Journal d'audit ─────────────────────────────────────────────────────────
--
-- ⚠️ `ADD VALUE` sur un type énuméré ne peut PAS tourner dans la même
-- transaction que son utilisation, sous PostgreSQL. Ces deux valeurs sont
-- donc ajoutées ici, et ne sont écrites que par du code déployé APRÈS cette
-- migration — la règle du dépôt (« la migration part avant le code ») suffit.
--
-- `IF NOT EXISTS` : un rejeu partiel de cette migration mourait autrefois sur
-- un `ADD VALUE` déjà appliqué, laissant tout le reste non joué.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DRIVER_SETTLEMENT_RECORDED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DRIVER_SETTLEMENT_CANCELLED';

-- CreateEnum
CREATE TYPE "DriverSettlementMethod" AS ENUM ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "DriverSettlementStatus" AS ENUM ('PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "driverSettlementId" TEXT;

-- CreateTable
CREATE TABLE "driver_settlements" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "amountXaf" INTEGER NOT NULL,
    "courseCount" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "coveredUntil" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "status" "DriverSettlementStatus" NOT NULL DEFAULT 'PAID',
    "method" "DriverSettlementMethod" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_settlements_driverId_status_idx" ON "driver_settlements"("driverId", "status");

-- CreateIndex
CREATE INDEX "driver_settlements_driverId_paidAt_idx" ON "driver_settlements"("driverId", "paidAt");

-- CreateIndex
CREATE INDEX "Delivery_driverSettlementId_idx" ON "Delivery"("driverSettlementId");

-- CreateIndex
CREATE INDEX "Delivery_delivererId_status_driverSettlementId_idx" ON "Delivery"("delivererId", "status", "driverSettlementId");

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_driverSettlementId_fkey" FOREIGN KEY ("driverSettlementId") REFERENCES "driver_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

