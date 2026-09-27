-- F3-12.1 R7 — ban différé d'un livreur en pleine course (décisions Q3/Q7).
--
-- Additive : trois colonnes nullables, aucune ligne existante touchée. Tant
-- qu'aucun ban n'est demandé sur un livreur en course, rien ne change.
--
-- ⚠️ `migrate diff` proposait aussi `DROP INDEX "Refund_status_provider_idx"` :
-- dérive préexistante entre migrations et schéma, hors de propos ici — retirée.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "banPendingAt" TIMESTAMP(3),
ADD COLUMN     "banPendingById" TEXT,
ADD COLUMN     "banPendingReason" TEXT;

-- Un ban en attente n'existe que sur un compte encore actif : appliqué, il
-- devient `BLOCKED` et le drapeau disparaît dans la même écriture.
ALTER TABLE "User" ADD CONSTRAINT "User_ban_pending_consistent" CHECK (
  "banPendingAt" IS NULL OR "statusUser" = 'ACTIVE'
);
