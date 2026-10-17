-- ════════════════════════════════════════════════════════════════════════════
-- PREMIUM (Lot 3) — configuration de la réservation sur place — 12 octobre 2026
--
-- Un restaurant Premium décrit son service de réservation : réglages, tables
-- et espaces de places, plages hebdomadaires. Aucune réservation client n'est
-- créée par ce lot.
--
-- ENTIÈREMENT ADDITIVE :
--   · une colonne avec défaut sur `PlatformSettings` (`reservationsEnabled`,
--     false : la ligne `singleton` existante prend false) ;
--   · trois tables vides.
-- Aucune donnée existante n'est lue, modifiée ou supprimée. Aucun `ALTER TYPE`
-- (l'enum `DayOfWeek` existe déjà et n'est pas modifié).
--
-- ATOMIQUE : la migration est enveloppée dans BEGIN/COMMIT. Un échec à
-- n'importe quelle étape ne laisse rien derrière lui (leçon D1 du Lot 2 :
-- une migration Prisma n'est pas transactionnelle d'elle-même). La reprise
-- après échec se réduit donc à :
--   prisma migrate resolve --rolled-back 20261012120000_reservation_settings
-- puis corriger et redéployer.
--
-- Vocabulaire `kind` en TEXT + CHECK (règle 14) ; liste miroir dans
-- `apps/lilia-app/src/modules/reservations/reservation-vocab.ts`. Bornes
-- miroirs de `reservation-config.ts` (décisions D5–D10, D15).
--
-- ROLLBACK COMPLET (si la feature est retirée, APRÈS retour du code) :
--   BEGIN;
--   DROP TABLE "ReservationWindow";
--   DROP TABLE "ReservationSpace";
--   DROP TABLE "ReservationSettings";
--   ALTER TABLE "PlatformSettings" DROP COLUMN "reservationsEnabled";
--   DELETE FROM "_prisma_migrations"
--     WHERE migration_name = '20261012120000_reservation_settings';
--   COMMIT;
-- (sans la dernière ligne, `migrate deploy` croirait la base à jour et ne
-- recréerait jamais les tables — défaut D2 du Lot 2).
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Ajouter une clé étrangère verrouille "Restaurant" (SHARE ROW EXCLUSIVE),
-- table touchée chaque minute par le cron d'ouverture. Sans borne, une attente
-- de verrou mettrait en file tout le trafic derrière elle : on préfère échouer
-- vite (rollback complet, reprise par `migrate resolve --rolled-back`).
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "reservationsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ReservationSettings" (
    "restaurantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "slotDurationMin" INTEGER NOT NULL DEFAULT 90,
    "slotStepMin" INTEGER NOT NULL DEFAULT 30,
    "bufferMin" INTEGER NOT NULL DEFAULT 15,
    "minLeadMin" INTEGER NOT NULL DEFAULT 120,
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 30,
    "maxPartySize" INTEGER NOT NULL DEFAULT 8,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationSettings_pkey" PRIMARY KEY ("restaurantId"),
    CONSTRAINT "ReservationSettings_slotDurationMin_check"
      CHECK ("slotDurationMin" BETWEEN 30 AND 240),
    CONSTRAINT "ReservationSettings_slotStepMin_check"
      CHECK ("slotStepMin" IN (15, 30, 60)),
    CONSTRAINT "ReservationSettings_bufferMin_check"
      CHECK ("bufferMin" BETWEEN 0 AND 60),
    CONSTRAINT "ReservationSettings_minLeadMin_check"
      CHECK ("minLeadMin" BETWEEN 30 AND 2880),
    CONSTRAINT "ReservationSettings_maxAdvanceDays_check"
      CHECK ("maxAdvanceDays" BETWEEN 1 AND 90),
    CONSTRAINT "ReservationSettings_maxPartySize_check"
      CHECK ("maxPartySize" BETWEEN 1 AND 50),
    CONSTRAINT "ReservationSettings_version_check"
      CHECK ("version" >= 1)
);

-- CreateTable
CREATE TABLE "ReservationSpace" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "labelKey" TEXT NOT NULL,
    "minGuests" INTEGER,
    "maxGuests" INTEGER,
    "seatCount" INTEGER,
    "maxSeatsPerBooking" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationSpace_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReservationSpace_kind_check"
      CHECK ("kind" IN ('TABLE', 'SEATS')),
    CONSTRAINT "ReservationSpace_label_check"
      CHECK (char_length("label") BETWEEN 1 AND 40 AND char_length("labelKey") >= 1),
    -- Une table porte une plage de groupe et rien d'autre ; un espace de places
    -- porte une capacité et un plafond par réservation, et rien d'autre.
    CONSTRAINT "ReservationSpace_shape_check"
      CHECK (
        ("kind" = 'TABLE'
          AND "minGuests" IS NOT NULL AND "maxGuests" IS NOT NULL
          AND "minGuests" >= 1 AND "minGuests" <= "maxGuests" AND "maxGuests" <= 50
          AND "seatCount" IS NULL AND "maxSeatsPerBooking" IS NULL)
        OR
        ("kind" = 'SEATS'
          AND "seatCount" IS NOT NULL AND "maxSeatsPerBooking" IS NOT NULL
          AND "seatCount" BETWEEN 1 AND 200
          AND "maxSeatsPerBooking" >= 1 AND "maxSeatsPerBooking" <= "seatCount"
          AND "maxSeatsPerBooking" <= 50
          AND "minGuests" IS NULL AND "maxGuests" IS NULL)
      )
);

-- CreateTable
CREATE TABLE "ReservationWindow" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationWindow_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReservationWindow_time_format_check"
      CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    -- "HH:mm" à zéros de tête : l'ordre lexical est l'ordre horaire. Aucune
    -- plage ne traverse minuit (D3).
    CONSTRAINT "ReservationWindow_order_check"
      CHECK ("startTime" < "endTime")
);

-- CreateIndex
CREATE INDEX "ReservationSpace_restaurantId_archivedAt_idx" ON "ReservationSpace"("restaurantId", "archivedAt");

-- Unicité des libellés parmi les ressources actives (D15) : une ressource
-- archivée libère son libellé. Partiel, donc hors du schéma Prisma.
CREATE UNIQUE INDEX "ReservationSpace_active_label_key"
  ON "ReservationSpace"("restaurantId", "labelKey")
  WHERE "archivedAt" IS NULL;

-- CreateIndex
CREATE INDEX "ReservationWindow_restaurantId_dayOfWeek_idx" ON "ReservationWindow"("restaurantId", "dayOfWeek");

-- AddForeignKey
ALTER TABLE "ReservationSettings" ADD CONSTRAINT "ReservationSettings_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT, comme VendorSubscription et VendorOffer : les réservations des
-- lots suivants référenceront ces ressources ; une suppression de restaurant
-- ne doit pas les effacer en silence.
ALTER TABLE "ReservationSpace" ADD CONSTRAINT "ReservationSpace_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationWindow" ADD CONSTRAINT "ReservationWindow_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
