-- Durcissement lot 5 (07/11/2026, D-3 ; renommée le 15/11 pour suivre dispatch_fcfs) — taux estimés des frais pawaPay.
--
-- ADDITIVE : deux colonnes NULL sur une table d'une ligne, aucune ligne
-- réécrite. NULL = pas de taux : le poste reste INCONNU dans la vue de marge.
-- Ces taux ne fixent aucun prix et n'entrent jamais au grand livre.
--
-- Rollback : revenir au code précédent suffit (il ignore ces colonnes). Si
-- besoin, après retour du code :
--   ALTER TABLE "PlatformSettings" DROP COLUMN "estimatedCollectionFeeBps",
--     DROP COLUMN "estimatedPayoutFeeBps";

ALTER TABLE "PlatformSettings"
  ADD COLUMN "estimatedCollectionFeeBps" INTEGER,
  ADD COLUMN "estimatedPayoutFeeBps" INTEGER;

ALTER TABLE "PlatformSettings"
  ADD CONSTRAINT "PlatformSettings_estimatedCollectionFeeBps_range"
    CHECK ("estimatedCollectionFeeBps" IS NULL OR "estimatedCollectionFeeBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "PlatformSettings_estimatedPayoutFeeBps_range"
    CHECK ("estimatedPayoutFeeBps" IS NULL OR "estimatedPayoutFeeBps" BETWEEN 0 AND 10000);
