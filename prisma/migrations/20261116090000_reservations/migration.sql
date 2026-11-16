-- ════════════════════════════════════════════════════════════════════════════
-- LOT 4 (4B-1) — réservations sur place, parcours client — 18 octobre 2026
--
-- Un client demande une table avec sa précommande de plats ; le restaurant
-- accepte ou refuse. Le paiement qui confirme la réservation (4B-2) n'est PAS
-- dans cette migration : aucune colonne d'argent, aucune modification de
-- `Order`, `Payment` ni d'une contrainte existante.
--
-- ENTIÈREMENT ADDITIVE : quatre tables vides. Aucune donnée existante n'est
-- lue, modifiée ou supprimée. Aucun `ALTER TYPE`, aucun enum PostgreSQL :
-- statuts, motifs et acteurs en TEXT + CHECK (règle 14), listes miroirs dans
-- `apps/lilia-app/src/modules/reservations/reservation-booking-vocab.ts`.
--
-- ATOMIQUE : BEGIN/COMMIT. Un échec ne laisse rien derrière lui ; reprise :
--   prisma migrate resolve --rolled-back 20261116090000_reservations
-- puis corriger et redéployer.
--
-- Clés étrangères : `Restaurant`, `User` et `ReservationSpace` en RESTRICT (une
-- réservation est une pièce d'historique) ; les plats précommandés ne pointent
-- PAS le catalogue (identifiants simples) pour ne bloquer ni la suppression
-- d'un menu du jour ni celle d'un produit jamais vendu.
--
-- Aucune contrainte d'exclusion (`btree_gist`) : la non-superposition des
-- réservations est garantie par le verrou `Restaurant … FOR NO KEY UPDATE`
-- pris par toute écriture qui consomme de la capacité (03-approval §6).
--
-- ROLLBACK COMPLET (si la feature est retirée, APRÈS retour du code) :
--   BEGIN;
--   DROP TABLE "ReservationEvent";
--   DROP TABLE "ReservationItemOption";
--   DROP TABLE "ReservationItem";
--   DROP TABLE "Reservation";
--   DELETE FROM "_prisma_migrations"
--     WHERE migration_name = '20261116090000_reservations';
--   COMMIT;
-- (sans la dernière ligne, `migrate deploy` croirait la base à jour et ne
-- recréerait jamais les tables — défaut D2 du Lot 2). ⚠️ Le rollback efface
-- les réservations : à ne jouer qu'interrupteur éteint et sans réservation.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Une table verrouillée trop longtemps fait échouer la migration au lieu de
-- bloquer la production (rollback complet, reprise par `migrate resolve`).
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "partySize" INTEGER NOT NULL,
    "arrivalAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "occupiedUntil" TIMESTAMP(3) NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "note" TEXT,
    "requestKey" TEXT NOT NULL,
    "responseDeadlineAt" TIMESTAMP(3) NOT NULL,
    "paymentDeadlineAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "honoredAt" TIMESTAMP(3),
    "noShowAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Reservation_status_check" CHECK ("status" IN (
      'PENDING', 'AWAITING_PAYMENT', 'CONFIRMED', 'DECLINED', 'EXPIRED',
      'CANCELLED_BY_CLIENT', 'CANCELLED_BY_VENDOR', 'HONORED', 'NO_SHOW'
    )),
    CONSTRAINT "Reservation_partySize_check" CHECK ("partySize" BETWEEN 1 AND 50),
    CONSTRAINT "Reservation_interval_check"
      CHECK ("endsAt" > "arrivalAt" AND "occupiedUntil" >= "endsAt"),
    CONSTRAINT "Reservation_responseDeadline_check"
      CHECK ("responseDeadlineAt" <= "arrivalAt"),
    CONSTRAINT "Reservation_paymentDeadline_check"
      CHECK ("paymentDeadlineAt" IS NULL OR "paymentDeadlineAt" <= "arrivalAt"),
    CONSTRAINT "Reservation_requestKey_check"
      CHECK (char_length("requestKey") BETWEEN 1 AND 100),
    CONSTRAINT "Reservation_note_check"
      CHECK ("note" IS NULL OR char_length("note") <= 280),
    CONSTRAINT "Reservation_contactPhone_check"
      CHECK (char_length("contactPhone") BETWEEN 6 AND 20),
    -- Un motif de refus n'existe qu'en DECLINED, et y est obligatoire.
    CONSTRAINT "Reservation_declineReason_check" CHECK (
      ("status" = 'DECLINED') = ("declineReason" IS NOT NULL)
      AND ("declineReason" IS NULL OR "declineReason" IN (
        'FULLY_BOOKED', 'CLOSED', 'ITEMS_UNAVAILABLE', 'PARTY_TOO_LARGE', 'OTHER'
      ))
    ),
    -- Un motif d'annulation vendeur n'existe qu'en CANCELLED_BY_VENDOR.
    CONSTRAINT "Reservation_cancelReason_check" CHECK (
      ("status" = 'CANCELLED_BY_VENDOR') = ("cancelReason" IS NOT NULL)
      AND ("cancelReason" IS NULL OR "cancelReason" IN (
        'CLOSED_UNEXPECTEDLY', 'ITEMS_UNAVAILABLE', 'OVERBOOKED',
        'CLIENT_REQUEST', 'OTHER'
      ))
    ),
    -- Un délai de paiement n'existe qu'après l'acceptation du vendeur.
    CONSTRAINT "Reservation_paymentDeadline_after_accept_check" CHECK (
      "paymentDeadlineAt" IS NULL OR "acceptedAt" IS NOT NULL
    ),
    -- Une absence porte sa date ; une réservation hors NO_SHOW n'en porte pas
    -- (le retrait d'une absence efface `noShowAt`).
    CONSTRAINT "Reservation_noShow_check"
      CHECK (("status" = 'NO_SHOW') = ("noShowAt" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "ReservationItem" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "menuId" TEXT,
    "variantId" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "optionsSignature" TEXT NOT NULL DEFAULT '',
    "productName" TEXT NOT NULL,
    "variantLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReservationItem_quantite_check" CHECK ("quantite" BETWEEN 1 AND 50)
);

-- CreateTable
CREATE TABLE "ReservationItemOption" (
    "itemId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ReservationItemOption_pkey" PRIMARY KEY ("itemId","optionId"),
    CONSTRAINT "ReservationItemOption_quantity_check" CHECK ("quantity" >= 1)
);

-- CreateTable
CREATE TABLE "ReservationEvent" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "fromSpaceId" TEXT,
    "toSpaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReservationEvent_actorRole_check"
      CHECK ("actorRole" IN ('CLIENT', 'RESTAURATEUR', 'SYSTEM', 'ADMIN'))
);

-- CreateIndex
CREATE INDEX "Reservation_restaurantId_arrivalAt_idx" ON "Reservation"("restaurantId", "arrivalAt");

-- CreateIndex
CREATE INDEX "Reservation_spaceId_arrivalAt_idx" ON "Reservation"("spaceId", "arrivalAt");

-- CreateIndex
CREATE INDEX "Reservation_userId_createdAt_idx" ON "Reservation"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Reservation_status_responseDeadlineAt_idx" ON "Reservation"("status", "responseDeadlineAt");

-- CreateIndex
CREATE INDEX "Reservation_status_paymentDeadlineAt_idx" ON "Reservation"("status", "paymentDeadlineAt");

-- CreateIndex
-- Sert la restriction après absences (B2) : NO_SHOW d'un client sur 90 jours.
CREATE INDEX "Reservation_userId_status_noShowAt_idx" ON "Reservation"("userId", "status", "noShowAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_userId_requestKey_key" ON "Reservation"("userId", "requestKey");

-- CreateIndex
CREATE INDEX "ReservationItem_reservationId_idx" ON "ReservationItem"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationEvent_reservationId_createdAt_idx" ON "ReservationEvent"("reservationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "ReservationSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationItem" ADD CONSTRAINT "ReservationItem_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationItemOption" ADD CONSTRAINT "ReservationItemOption_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ReservationItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationEvent" ADD CONSTRAINT "ReservationEvent_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
