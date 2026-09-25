-- F3-07 — preuve de remise, échéance de versement, code de retrait au comptoir.
--
-- Entièrement additive : quatre colonnes nullables sur "Order", une table, un
-- paramètre avec défaut. Toutes les lignes existantes ont les colonnes à NULL,
-- et chaque CHECK ci-dessous est satisfaite par NULL : elles sont donc posées
-- directement valides, sans NOT VALID — aucune ligne existante ne peut les
-- violer. Une commande antérieure garde `deliveryProof = NULL` et n'est jamais
-- versée automatiquement (I-17).
--
-- Les numéros I-n renvoient à la matrice d'invariants de
-- F3-07-PICKUP-CONFIRMATION-DISCOVERY.md (§16-17).

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "deliveryProof" TEXT,
  ADD COLUMN "customerConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "payoutDueAt" TIMESTAMP(3);

-- I-1 — valeurs bornées (miroir de `DELIVERY_PROOFS`).
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryProof_valid" CHECK (
  "deliveryProof" IS NULL OR "deliveryProof" IN (
    'DELIVERY_CODE', 'DELIVERY_ADMIN_OVERRIDE', 'DELIVERY_UNVERIFIED',
    'PICKUP_CODE', 'PICKUP_CUSTOMER_CONFIRMED', 'PICKUP_ADMIN_OVERRIDE',
    'PICKUP_VENDOR_DECLARED'
  )
);

-- I-2, I-3 — une preuve n'existe que sur une commande livrée, datée.
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryProof_needs_livrer" CHECK (
  "deliveryProof" IS NULL
  OR ("status" = 'LIVRER' AND "deliveredAt" IS NOT NULL)
);

-- I-4 — une preuve de retrait sur un retrait, une preuve de course sur une livraison.
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryProof_matches_mode" CHECK (
  "deliveryProof" IS NULL
  OR (("deliveryProof" LIKE 'PICKUP\_%') = (NOT "isDelivery"))
);

-- I-5 — la date de confirmation client va avec, et seulement avec, sa preuve.
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerConfirmedAt_matches_proof" CHECK (
  ("customerConfirmedAt" IS NOT NULL)
  = (COALESCE("deliveryProof", '') = 'PICKUP_CUSTOMER_CONFIRMED')
);

-- I-6, I-7 — invariant central : une échéance de versement existe si et
-- seulement si la preuve est fiable. Jamais sur PICKUP_VENDOR_DECLARED ni sur
-- DELIVERY_UNVERIFIED ; jamais oubliée sur une preuve fiable.
ALTER TABLE "Order" ADD CONSTRAINT "Order_payoutDueAt_needs_proof" CHECK (
  ("payoutDueAt" IS NOT NULL) = (COALESCE("deliveryProof", '') IN (
    'DELIVERY_CODE', 'DELIVERY_ADMIN_OVERRIDE',
    'PICKUP_CODE', 'PICKUP_CUSTOMER_CONFIRMED', 'PICKUP_ADMIN_OVERRIDE'
  ))
);

-- I-8 — on ne paie jamais avant la preuve.
ALTER TABLE "Order" ADD CONSTRAINT "Order_payoutDueAt_after_proof" CHECK (
  "payoutDueAt" IS NULL
  OR (
    "payoutDueAt" >= "deliveredAt"
    AND ("customerConfirmedAt" IS NULL OR "payoutDueAt" >= "customerConfirmedAt")
  )
);

-- Versements automatiques : le worker ne lit que les commandes échues.
CREATE INDEX "Order_payoutDueAt_idx" ON "Order"("payoutDueAt")
  WHERE "payoutDueAt" IS NOT NULL;

-- CreateTable — code de retrait au comptoir (D-P5).
CREATE TABLE "PickupHandover" (
    "orderId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickupHandover_pkey" PRIMARY KEY ("orderId")
);

ALTER TABLE "PickupHandover" ADD CONSTRAINT "PickupHandover_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "PlatformSettings"
  ADD COLUMN "vendorPayoutDelayMinutes" INTEGER NOT NULL DEFAULT 60;

-- I-16 — délai borné. La table n'a qu'une ligne, au défaut.
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_payout_delay_bounds" CHECK (
  "vendorPayoutDelayMinutes" BETWEEN 0 AND 1440
);
