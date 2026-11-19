-- ════════════════════════════════════════════════════════════════════════════
-- LOT 4 (4B-2, J6b) — versement de la part restaurant d'une absence — 19/11/2026
--
-- Décision du propriétaire (19/11) : la part due au restaurant
-- (`ReservationNoShowSettlement.vendorShareXaf`) est versée par l'application
-- via pawaPay, demandée par un administrateur (FINANCE_EXECUTE) et validée par
-- un second (FINANCE_APPROVE + MFA). Conception : `16-J6b-design.md`.
--
-- ENTIÈREMENT ADDITIVE : une table nouvelle, vide. Aucun enum créé (statut
-- TEXT + CHECK, règle 14), aucune donnée existante lue ni réécrite.
--
-- Garanties portées par la base :
--   - au plus UN versement en cours ou abouti par absence (index unique
--     partiel) : deux validations simultanées ne paient pas deux fois ;
--   - identifiant prestataire unique (idempotence d'un rejeu) ;
--   - une approbation ne sert qu'à un seul versement ;
--   - quatre yeux : le valideur n'est jamais le demandeur ;
--   - un versement abouti porte sa date d'aboutissement.
--
-- ATOMIQUE : BEGIN/COMMIT. Reprise après échec :
--   prisma migrate resolve --rolled-back 20261119120100_reservation_no_show_payout
--
-- ROLLBACK COMPLET (APRÈS retour du code ; aucune ligne de versement ni aucune
-- écriture `no_show_payout:*` au grand livre — sinon les contre-passer d'abord) :
--   BEGIN;
--   DROP TABLE "ReservationNoShowPayout";
--   DELETE FROM "_prisma_migrations"
--     WHERE migration_name = '20261119120100_reservation_no_show_payout';
--   COMMIT;
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE "ReservationNoShowPayout" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "amountXaf" INTEGER NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "payoutProvider" "PayoutProvider" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPayoutId" TEXT NOT NULL,
    "providerTransactionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReservationNoShowPayout_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReservationNoShowPayout_status_check" CHECK (
      "status" IN ('PENDING', 'SUCCESS', 'FAILED')),
    CONSTRAINT "ReservationNoShowPayout_amount_check" CHECK ("amountXaf" > 0),
    CONSTRAINT "ReservationNoShowPayout_four_eyes" CHECK (
      "approvedBy" <> "requestedBy"),
    CONSTRAINT "ReservationNoShowPayout_success_completed" CHECK (
      "status" <> 'SUCCESS' OR "completedAt" IS NOT NULL)
);

CREATE UNIQUE INDEX "ReservationNoShowPayout_providerPayoutId_key" ON "ReservationNoShowPayout"("providerPayoutId");

CREATE UNIQUE INDEX "ReservationNoShowPayout_approvalId_key" ON "ReservationNoShowPayout"("approvalId");

-- Au plus un versement en cours ou abouti par absence ; les échecs restent
-- en historique et n'empêchent pas une nouvelle demande.
CREATE UNIQUE INDEX "ReservationNoShowPayout_one_active_per_settlement" ON "ReservationNoShowPayout"("settlementId")
  WHERE "status" IN ('PENDING', 'SUCCESS');

CREATE INDEX "ReservationNoShowPayout_settlementId_createdAt_idx" ON "ReservationNoShowPayout"("settlementId", "createdAt");

CREATE INDEX "ReservationNoShowPayout_status_updatedAt_idx" ON "ReservationNoShowPayout"("status", "updatedAt");

CREATE INDEX "ReservationNoShowPayout_restaurantId_idx" ON "ReservationNoShowPayout"("restaurantId");

ALTER TABLE "ReservationNoShowPayout" ADD CONSTRAINT "ReservationNoShowPayout_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "ReservationNoShowSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationNoShowPayout" ADD CONSTRAINT "ReservationNoShowPayout_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
