-- ════════════════════════════════════════════════════════════════════════════
-- JOURNAL D'ASSIGNATION DES COURSES — 19 septembre 2026
--
-- Avant cette table, une réassignation ne laissait AUCUNE trace : `Delivery`
-- ne porte que la main courante. On ne pouvait répondre à aucune des questions
-- que pose un litige — qui était assigné, combien de temps, pourquoi il a été
-- retiré, qui l'a retiré, combien de fois la course a changé de mains. Le seul
-- indice était le message push envoyé à l'ancien livreur, qui ne se relit pas.
--
-- `OrderHistory` ne pouvait pas l'accueillir : une assignation ne change pas
-- `Order.status` (on assigne dès PAYER, on réassigne en PRET ou en EN_ROUTE),
-- donc les lignes auraient été `PRET → PRET` — comptées comme des transitions
-- par toute agrégation de durée par étape.
--
-- Pas d'économie par tentative : la politique est « seul le livreur qui TERMINE
-- est payé » (D-3), donc le coût d'une tentative avortée est connu et vaut
-- zéro. Le snapshot reste sur `Delivery`, seule autorité lue par
-- `DriverSettlementService`.
--
-- ENTIÈREMENT ADDITIVE. Aucun backfill : les courses antérieures n'ont pas
-- d'historique d'assignation, et on n'en invente pas une à partir du
-- `delivererId` courant — elle prétendrait qu'il n'y a jamais eu qu'une main.
-- ════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "DeliveryAssignmentOutcome" AS ENUM ('COMPLETED', 'REASSIGNED', 'DECLINED', 'FAILED', 'ORDER_CANCELLED');

-- CreateTable
CREATE TABLE "DeliveryAssignment" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "delivererId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedByUserId" TEXT,
    "assignedByRole" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "outcome" "DeliveryAssignmentOutcome",
    "releaseReason" TEXT,

    CONSTRAINT "DeliveryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- `releasedAt` en second : c'est le discriminant de la ligne ouverte, lue à
-- chaque assignation, acceptation, récupération et clôture.
CREATE INDEX "DeliveryAssignment_deliveryId_releasedAt_idx" ON "DeliveryAssignment"("deliveryId", "releasedAt");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_deliveryId_assignedAt_idx" ON "DeliveryAssignment"("deliveryId", "assignedAt");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_delivererId_assignedAt_idx" ON "DeliveryAssignment"("delivererId", "assignedAt" DESC);

-- CreateIndex
CREATE INDEX "DeliveryAssignment_orderId_idx" ON "DeliveryAssignment"("orderId");

-- AddForeignKey
-- Cascade : une ligne d'assignation n'a aucun sens sans sa livraison, comme
-- `DeliveryLocation`.
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict : supprimer un compte livreur ne doit pas effacer la trace des
-- courses qu'il a tenues. `UserDeletionService` anonymise, il ne supprime pas.
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_delivererId_fkey" FOREIGN KEY ("delivererId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
