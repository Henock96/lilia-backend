-- ════════════════════════════════════════════════════════════════════════════
-- LOT 4 (4B-2, J6) — absence d'un client qui a payé — 19 novembre 2026
--
-- Décisions du propriétaire (OD-08 option D, OD-22 rouvert, 18-19/11) : un
-- client absent n'est pas remboursé ; à la clôture de l'absence (12 h après sa
-- déclaration), l'encaissement est partagé entre Lilia et le restaurant
-- (`reservationNoShowVendorShareBps`, 50 % par défaut). La part du restaurant
-- n'est jamais versée automatiquement (règle 8). Plan : `15-J6-plan.md`.
--
-- ENTIÈREMENT ADDITIVE :
--   - `PlatformSettings.reservationNoShowVendorShareBps` (défaut constant) ;
--   - table `ReservationNoShowSettlement` (nouvelle, vide) ;
--   - grand livre : les deux listes contrôlées (`LedgerTransaction.kind`,
--     `LedgerEntry.account`) sont ÉLARGIES à `FORFEIT` et `revenue:forfeit`.
--     Toute ligne existante satisfait la nouvelle contrainte (sur-ensemble de
--     l'ancienne).
-- Aucun enum PostgreSQL touché, aucune donnée existante réécrite.
--
-- Verrous : `ADD COLUMN … DEFAULT <constante>` = métadonnée seule (PG ≥ 11) ;
-- le remplacement des CHECK du grand livre prend un verrou exclusif bref sur
-- `LedgerTransaction` et `LedgerEntry` (écritures du poster en attente), la
-- vérification est faite par `VALIDATE` (verrou qui laisse passer les
-- lectures et écritures). `lock_timeout` fait échouer plutôt que bloquer.
--
-- ATOMIQUE : BEGIN/COMMIT. Reprise après échec :
--   prisma migrate resolve --rolled-back 20261119090000_reservation_no_show_settlement
--
-- ROLLBACK COMPLET (APRÈS retour du code ; aucune ligne de partage ni aucune
-- écriture FORFEIT — sinon les contre-passer d'abord) :
--   BEGIN;
--   DROP TABLE "ReservationNoShowSettlement";
--   ALTER TABLE "PlatformSettings"
--     DROP CONSTRAINT "PlatformSettings_reservationNoShowVendorShareBps_check",
--     DROP COLUMN "reservationNoShowVendorShareBps";
--   ALTER TABLE "LedgerTransaction" DROP CONSTRAINT "LedgerTransaction_kind_known",
--     ADD CONSTRAINT "LedgerTransaction_kind_known" CHECK ("kind" IN (
--       'COLLECTION', 'ACQUISITION', 'DRIVER_COST', 'REFUND', 'PAYOUT',
--       'PSP_FEE', 'DRIVER_SETTLEMENT', 'VENDOR_ADJUSTMENT', 'REVERSAL'));
--   ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_account_known",
--     ADD CONSTRAINT "LedgerEntry_account_known" CHECK ("account" ~ '^(psp:[A-Z_]+|cash:manual|suspense:unmatched|clearing:order|vendor_payable|driver_payable|revenue:(service_fee|commission|delivery)|expense:(platform_discount|refund_platform|driver_cost|psp_fee|vendor_adjustment))$');
--   DELETE FROM "_prisma_migrations"
--     WHERE migration_name = '20261119090000_reservation_no_show_settlement';
--   COMMIT;
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─── 1. Réglage financier (R-09) ────────────────────────────────────────────

ALTER TABLE "PlatformSettings" ADD COLUMN "reservationNoShowVendorShareBps" INTEGER NOT NULL DEFAULT 5000;

ALTER TABLE "PlatformSettings"
  ADD CONSTRAINT "PlatformSettings_reservationNoShowVendorShareBps_check"
  CHECK ("reservationNoShowVendorShareBps" BETWEEN 0 AND 9999);

-- ─── 2. Partage de l'encaissement d'une absence ─────────────────────────────

CREATE TABLE "ReservationNoShowSettlement" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "totalXaf" INTEGER NOT NULL,
    "vendorShareXaf" INTEGER NOT NULL,
    "platformShareXaf" INTEGER NOT NULL,
    "vendorShareBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationNoShowSettlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReservationNoShowSettlement_amounts_check" CHECK (
      "totalXaf" >= 0
      AND "vendorShareXaf" >= 0
      AND "platformShareXaf" >= 0
      AND "vendorShareXaf" + "platformShareXaf" = "totalXaf"),
    CONSTRAINT "ReservationNoShowSettlement_bps_check" CHECK (
      "vendorShareBps" BETWEEN 0 AND 9999)
);

CREATE UNIQUE INDEX "ReservationNoShowSettlement_reservationId_key" ON "ReservationNoShowSettlement"("reservationId");

CREATE UNIQUE INDEX "ReservationNoShowSettlement_orderId_key" ON "ReservationNoShowSettlement"("orderId");

CREATE INDEX "ReservationNoShowSettlement_restaurantId_createdAt_idx" ON "ReservationNoShowSettlement"("restaurantId", "createdAt");

ALTER TABLE "ReservationNoShowSettlement" ADD CONSTRAINT "ReservationNoShowSettlement_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationNoShowSettlement" ADD CONSTRAINT "ReservationNoShowSettlement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationNoShowSettlement" ADD CONSTRAINT "ReservationNoShowSettlement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 3. Grand livre : écriture « montant retenu » ───────────────────────────

ALTER TABLE "LedgerTransaction"
  DROP CONSTRAINT "LedgerTransaction_kind_known",
  ADD CONSTRAINT "LedgerTransaction_kind_known" CHECK ("kind" IN (
    'COLLECTION', 'ACQUISITION', 'DRIVER_COST', 'REFUND', 'PAYOUT',
    'PSP_FEE', 'DRIVER_SETTLEMENT', 'VENDOR_ADJUSTMENT', 'REVERSAL',
    'FORFEIT')) NOT VALID;

ALTER TABLE "LedgerTransaction" VALIDATE CONSTRAINT "LedgerTransaction_kind_known";

ALTER TABLE "LedgerEntry"
  DROP CONSTRAINT "LedgerEntry_account_known",
  ADD CONSTRAINT "LedgerEntry_account_known" CHECK ("account" ~ '^(psp:[A-Z_]+|cash:manual|suspense:unmatched|clearing:order|vendor_payable|driver_payable|revenue:(service_fee|commission|delivery|forfeit)|expense:(platform_discount|refund_platform|driver_cost|psp_fee|vendor_adjustment))$') NOT VALID;

ALTER TABLE "LedgerEntry" VALIDATE CONSTRAINT "LedgerEntry_account_known";

COMMIT;
