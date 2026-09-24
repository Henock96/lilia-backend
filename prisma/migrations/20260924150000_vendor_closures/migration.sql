-- F3-03 — fermetures qui se terminent seules : pause datée, congés, jours fériés.
-- Entièrement additive : l'ancien code tourne dessus (colonnes nullables ou à
-- défaut, deux tables neuves que personne ne lit encore).

ALTER TABLE "Restaurant"
  ADD COLUMN "pausedUntil" TIMESTAMP(3),
  ADD COLUMN "pauseReason" TEXT,
  ADD COLUMN "closedOnHolidays" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "VendorClosure" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VendorClosure_pkey" PRIMARY KEY ("id"),
  -- Table neuve, donc vide : la contrainte est validée à la création.
  CONSTRAINT "VendorClosure_endsAt_after_startsAt_chk" CHECK ("endsAt" > "startsAt")
);

CREATE INDEX "VendorClosure_restaurantId_endsAt_idx" ON "VendorClosure"("restaurantId", "endsAt");

ALTER TABLE "VendorClosure"
  ADD CONSTRAINT "VendorClosure_restaurantId_fkey" FOREIGN KEY ("restaurantId")
  REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PublicHoliday" (
  "date" DATE NOT NULL,
  "label" TEXT NOT NULL,
  "country" TEXT NOT NULL DEFAULT 'CG',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("date")
);
