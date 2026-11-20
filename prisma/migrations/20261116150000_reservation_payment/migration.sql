-- ════════════════════════════════════════════════════════════════════════════
-- LOT 4 (4B-2) — paiement des précommandes de réservation — 16 novembre 2026
--
-- Le restaurant accepte une demande : une commande liée naît (parcours
-- `ACCEPT_FIRST`, `EN_ATTENTE`), le client la paie par le chemin de paiement
-- existant, la réservation devient CONFIRMED dans la transaction qui fait
-- passer la commande à PAYER. Décisions : `11-decisions-1611.md` et
-- `14-4B2-decisions-impl.md` du dossier de la feature.
--
-- ENTIÈREMENT ADDITIVE (OD-19 : nouvelle migration, celle de 4B-1 n'est pas
-- touchée) :
--   - `Order.reservationId` nullable + index unique + clé étrangère RESTRICT ;
--   - colonnes indicatives nullables sur `Reservation`, `ReservationItem`,
--     `ReservationItemOption` (P-04) ; `lateCancellation` avec défaut ;
--     `paymentDueNoticeAt` nullable.
-- Aucune contrainte existante modifiée, aucun enum PostgreSQL touché, aucune
-- donnée existante lue ni réécrite. Toutes les commandes existantes gardent
-- `reservationId = NULL`.
--
-- Verrous : `ADD COLUMN` nullable sans défaut volatil = métadonnée seule ;
-- l'index unique sur `Order` se construit sous verrou SHARE (écritures de
-- commandes en attente le temps de la construction ; quelques centaines de
-- lignes en prod). `lock_timeout` fait échouer la migration plutôt que de
-- bloquer la production.
--
-- ATOMIQUE : BEGIN/COMMIT. Reprise après échec :
--   prisma migrate resolve --rolled-back 20261116150000_reservation_payment
--
-- ROLLBACK COMPLET (APRÈS retour du code ; interrupteur éteint, aucune
-- commande liée — sinon rembourser et clôturer d'abord) :
--   BEGIN;
--   ALTER TABLE "Order" DROP CONSTRAINT "Order_reservationId_fkey";
--   DROP INDEX "Order_reservationId_key";
--   ALTER TABLE "Order" DROP COLUMN "reservationId";
--   ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_lateCancellation_check",
--     DROP CONSTRAINT "Reservation_indicativeSubTotal_check",
--     DROP COLUMN "indicativeSubTotal",
--     DROP COLUMN "lateCancellation", DROP COLUMN "paymentDueNoticeAt";
--   ALTER TABLE "ReservationItem"
--     DROP CONSTRAINT "ReservationItem_indicativeLineTotal_check",
--     DROP COLUMN "indicativeLineTotal", DROP COLUMN "menuName";
--   ALTER TABLE "ReservationItemOption" DROP COLUMN "optionName",
--     DROP COLUMN "priceDelta";
--   DELETE FROM "_prisma_migrations"
--     WHERE migration_name = '20261116150000_reservation_payment';
--   COMMIT;
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Commande liée : au plus une par réservation.
ALTER TABLE "Order" ADD COLUMN "reservationId" TEXT;

CREATE UNIQUE INDEX "Order_reservationId_key" ON "Order"("reservationId");

ALTER TABLE "Order" ADD CONSTRAINT "Order_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Instantané indicatif (P-04) et suivi du paiement.
ALTER TABLE "Reservation"
  ADD COLUMN "indicativeSubTotal" INTEGER,
  ADD COLUMN "lateCancellation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "paymentDueNoticeAt" TIMESTAMP(3),
  ADD CONSTRAINT "Reservation_indicativeSubTotal_check"
    CHECK ("indicativeSubTotal" IS NULL OR "indicativeSubTotal" >= 0),
  -- Seule une annulation du client peut être tardive.
  ADD CONSTRAINT "Reservation_lateCancellation_check"
    CHECK (NOT "lateCancellation" OR "status" = 'CANCELLED_BY_CLIENT');

ALTER TABLE "ReservationItem"
  ADD COLUMN "indicativeLineTotal" INTEGER,
  ADD COLUMN "menuName" TEXT,
  ADD CONSTRAINT "ReservationItem_indicativeLineTotal_check"
    CHECK ("indicativeLineTotal" IS NULL OR "indicativeLineTotal" >= 0);

ALTER TABLE "ReservationItemOption"
  ADD COLUMN "optionName" TEXT,
  ADD COLUMN "priceDelta" INTEGER;

COMMIT;
