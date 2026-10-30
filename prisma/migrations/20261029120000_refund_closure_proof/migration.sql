-- Audit du 28/10/2026, F-12 — un remboursement « terminé » dit qui l'affirme.
--
-- Additive : trois colonnes facultatives, deux CHECK `NOT VALID`.
--
-- `NOT VALID` est délibéré : les contraintes s'appliquent à toute ligne
-- insérée ou modifiée à partir de maintenant, sans exiger des remboursements
-- historiques une preuve qu'on n'a pas. On ne valide PAS ces contraintes
-- (`VALIDATE CONSTRAINT`) : l'historique déclaratif resterait refusé.
-- Conséquence assumée : une modification future d'un remboursement historique
-- `COMPLETED` sans preuve sera refusée tant qu'on ne lui en donne pas une.
--
-- Reprise : seule une ligne `COMPLETED` portant une référence du prestataire
-- (`providerTransactionId`, rendue par pawaPay) est qualifiée `PROVIDER`. Tout
-- autre remboursement historique reste `closureMethod = NULL` : « non
-- qualifié ». Aucune référence ni date n'est inventée.
--
-- Rollback applicatif : l'ancienne version ignore les colonnes, mais ses
-- clôtures déclaratives sans référence seraient refusées par le CHECK — en cas
-- de retour arrière, `ALTER TABLE "Refund" DROP CONSTRAINT
-- "Refund_declared_closure_has_proof"` (aucune donnée perdue). Ne pas
-- supprimer les colonnes : elles portent les preuves saisies entre-temps.

ALTER TABLE "Refund"
  ADD COLUMN "closureMethod" TEXT,
  ADD COLUMN "externalReference" TEXT,
  ADD COLUMN "externalPaidAt" TIMESTAMP(3);

ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_closureMethod_known"
  CHECK (
    "closureMethod" IS NULL
    OR "closureMethod" IN ('PROVIDER', 'MOBILE_MONEY_MANUAL', 'CASH', 'BANK_TRANSFER', 'OTHER')
  ) NOT VALID;

-- Une clôture « remboursé » nouvelle ou modifiée porte sa preuve : soit le
-- prestataire, soit une référence externe datée.
--
-- ⚠️ `COALESCE` partout : un CHECK qui s'évalue à NULL PASSE. Écrit
-- `"closureMethod" = 'PROVIDER'`, la condition valait NULL pour une clôture
-- sans méthode — exactement le cas à refuser (constaté en test le 29/10).
ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_declared_closure_has_proof"
  CHECK (
    "status" <> 'COMPLETED'
    OR COALESCE("closureMethod", '') = 'PROVIDER'
    OR (
      COALESCE("closureMethod", '') <> ''
      AND COALESCE(length(btrim("externalReference")), 0) >= 4
      AND "externalPaidAt" IS NOT NULL
    )
  ) NOT VALID;

UPDATE "Refund"
SET "closureMethod" = 'PROVIDER'
WHERE "status" = 'COMPLETED'
  AND "provider" IS NOT NULL
  AND "providerTransactionId" IS NOT NULL;
