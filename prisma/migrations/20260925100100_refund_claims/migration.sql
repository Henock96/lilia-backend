-- F3-06 — remboursements partiels, réclamations, avoirs.
--
-- Entièrement additive, sauf un point : l'unicité `Refund(orderId)` devient
-- PARTIELLE. Les deux index partiels sont créés AVANT la suppression de
-- l'ancien, dans cette même transaction : il n'existe aucun instant où la
-- base accepterait deux remboursements en vol sur une même commande.

-- ── Types ───────────────────────────────────────────────────────────────────
CREATE TYPE "RefundReasonCode" AS ENUM ('ORDER_CANCELLED', 'VENDOR_REJECTED', 'VENDOR_TIMEOUT', 'DELIVERY_FAILED', 'MISSING_ITEM', 'WRONG_ITEM', 'DAMAGED', 'LATE', 'GOODWILL', 'OTHER');
CREATE TYPE "RefundBearer" AS ENUM ('VENDOR', 'PLATFORM', 'DRIVER');
CREATE TYPE "RefundLineKind" AS ENUM ('ITEM', 'DELIVERY_FEE', 'SERVICE_FEE', 'GOODWILL');
CREATE TYPE "MessageVisibility" AS ENUM ('ALL', 'STAFF_ONLY');
CREATE TYPE "PromoFunding" AS ENUM ('PLATFORM', 'VENDOR');

-- ── Refund ──────────────────────────────────────────────────────────────────
ALTER TABLE "Refund" ADD COLUMN "bearer" "RefundBearer" NOT NULL DEFAULT 'PLATFORM',
ADD COLUMN "incidentId" TEXT,
ADD COLUMN "reasonCode" "RefundReasonCode" NOT NULL DEFAULT 'ORDER_CANCELLED';

-- L'existant est qualifié, pas réécrit : un remboursement ouvert par la
-- conclusion d'un échec de livraison (F3-05) porte ce motif et le payeur
-- désigné par l'arbitrage. Tous les autres sont des annulations.
UPDATE "Refund" r
SET "reasonCode" = 'DELIVERY_FAILED',
    "bearer" = CASE o."failureLiability"
      WHEN 'VENDOR' THEN 'VENDOR'::"RefundBearer"
      WHEN 'DRIVER' THEN 'DRIVER'::"RefundBearer"
      ELSE 'PLATFORM'::"RefundBearer"
    END
FROM "Order" o
WHERE o.id = r."orderId" AND o.status = 'ECHEC_LIVRAISON';

-- R-06.1 — au plus un remboursement en vol par commande.
CREATE UNIQUE INDEX "Refund_orderId_inflight_uq" ON "Refund"("orderId")
  WHERE status IN ('PENDING', 'PROCESSING');
-- Au plus un remboursement total automatique par commande : c'est ce qui rend
-- l'outbox `order.refund_due` et la conclusion d'un échec rejouables.
CREATE UNIQUE INDEX "Refund_orderId_auto_uq" ON "Refund"("orderId")
  WHERE "reasonCode" IN ('ORDER_CANCELLED', 'VENDOR_REJECTED', 'VENDOR_TIMEOUT', 'DELIVERY_FAILED');
DROP INDEX "Refund_orderId_key";

CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");
CREATE INDEX "Refund_incidentId_idx" ON "Refund"("incidentId");
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RefundLine ──────────────────────────────────────────────────────────────
CREATE TABLE "RefundLine" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "kind" "RefundLineKind" NOT NULL,
    "orderItemId" TEXT,
    "quantity" INTEGER,
    "amountXaf" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundLine_pkey" PRIMARY KEY ("id"),
    -- Table neuve : contraintes validées d'emblée (aucune ligne à vérifier).
    CONSTRAINT "RefundLine_amount_positive_chk" CHECK ("amountXaf" > 0),
    CONSTRAINT "RefundLine_quantity_positive_chk" CHECK ("quantity" IS NULL OR "quantity" > 0),
    -- Une ligne ITEM désigne un article et une quantité ; les autres, jamais.
    CONSTRAINT "RefundLine_item_shape_chk" CHECK (
      ("kind" = 'ITEM' AND "orderItemId" IS NOT NULL AND "quantity" IS NOT NULL)
      OR ("kind" <> 'ITEM' AND "orderItemId" IS NULL AND "quantity" IS NULL)
    )
);
CREATE INDEX "RefundLine_refundId_idx" ON "RefundLine"("refundId");
CREATE INDEX "RefundLine_orderItemId_idx" ON "RefundLine"("orderItemId");
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── IncidentMessage ─────────────────────────────────────────────────────────
CREATE TABLE "IncidentMessage" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" "Role" NOT NULL,
    "visibility" "MessageVisibility" NOT NULL DEFAULT 'ALL',
    "body" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IncidentMessage_incidentId_createdAt_idx" ON "IncidentMessage"("incidentId", "createdAt");
ALTER TABLE "IncidentMessage" ADD CONSTRAINT "IncidentMessage_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentMessage" ADD CONSTRAINT "IncidentMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── PromoCode : avoirs nominatifs ───────────────────────────────────────────
ALTER TABLE "PromoCode" ADD COLUMN "assignedUserId" TEXT,
ADD COLUMN "fundingSource" "PromoFunding" NOT NULL DEFAULT 'PLATFORM';
CREATE INDEX "PromoCode_assignedUserId_idx" ON "PromoCode"("assignedUserId");
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Reversement : retenue des remboursements à la charge du vendeur ─────────
ALTER TABLE "restaurant_payouts" ADD COLUMN "refundDeductionAmount" INTEGER NOT NULL DEFAULT 0;
