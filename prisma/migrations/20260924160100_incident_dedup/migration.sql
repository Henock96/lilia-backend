-- F3-04 — une cause, un incident ouvert au plus (R-04.1).
--
-- L'unicité ne porte que sur les incidents OUVERTS : une fois résolue, la même
-- cause peut se reproduire et rouvrir un incident neuf. D'où un index unique
-- PARTIEL, que Prisma ne sait pas décrire — il vit ici seulement.
--
-- Deux workers qui détectent la même cause à la même minute : le second
-- INSERT tombe sur cet index (ON CONFLICT DO NOTHING), pas sur un doublon.
ALTER TABLE "Incident"
  ADD COLUMN "dedupKey" TEXT,
  ADD COLUMN "autoResolved" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Incident_dedupKey_open_uq"
  ON "Incident"("dedupKey")
  WHERE "dedupKey" IS NOT NULL AND "status" IN ('OPEN', 'IN_PROGRESS');
