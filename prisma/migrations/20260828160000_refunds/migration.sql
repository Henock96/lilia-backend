-- Remboursements des commandes annulées après paiement (fix H5, audit 28/08/2026).
--
-- Le client pouvait annuler lui-même une commande déjà réglée en MTN MoMo. Le
-- système restituait stock, points et code promo, mais la ligne `Payment`
-- restait SUCCESS, aucune entité ne matérialisait la dette, aucune tâche
-- n'apparaissait côté admin, et le montant « remboursable » sortait d'une
-- heuristique non documentée (`total >= 1000 ? total : 0`). L'annulation après
-- paiement est désormais réservée à l'ADMIN et ouvre une ligne ici.

CREATE TYPE "RefundStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'REJECTED'
);

CREATE TABLE "Refund" (
  "id"          TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "paymentId"   TEXT,
  "amount"      DOUBLE PRECISION NOT NULL,
  "status"      "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "reason"      TEXT NOT NULL,
  "requestedBy" TEXT,
  "processedBy" TEXT,
  "processedAt" TIMESTAMP(3),
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- Une commande = au plus un remboursement (rend `openForCancelledOrder`
-- idempotent : une annulation rejouée lève un P2002 qu'on absorbe).
CREATE UNIQUE INDEX "Refund_orderId_key" ON "Refund"("orderId");
CREATE INDEX "Refund_status_createdAt_idx" ON "Refund"("status", "createdAt");

ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index manquant relevé par l'audit (M19) : `assertNoPendingPayment` et le cron
-- d'expiration filtrent sur (orderId, status).
CREATE INDEX "payments_orderId_status_idx" ON "payments"("orderId", "status");
