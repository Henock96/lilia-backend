-- Exécution du virement de remboursement client (F-03, audit du 21/09/2026).
--
-- `Refund` était un REGISTRE DÉCLARATIF : un administrateur passait le statut à
-- `COMPLETED` à la main, et rien ne prouvait qu'un franc avait bougé. Le rail
-- existe pourtant depuis août (`PawaPayProvider.createPayout`, utilisé pour les
-- vendeurs) : un remboursement était le dernier mouvement d'argent sans trace
-- prestataire.
--
-- Migration ENTIÈREMENT ADDITIVE, toutes colonnes nullables : une instance de
-- l'ancien code tourne dessus sans rien casser, et les remboursements traités
-- hors application (espèces) restent représentables — `provider IS NULL`.

ALTER TABLE "Refund"
  ADD COLUMN IF NOT EXISTS "provider"              TEXT,
  ADD COLUMN IF NOT EXISTS "providerRefundId"      TEXT,
  ADD COLUMN IF NOT EXISTS "providerTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "phoneNumber"           TEXT,
  ADD COLUMN IF NOT EXISTS "payoutProvider"        "PayoutProvider",
  ADD COLUMN IF NOT EXISTS "failureCode"           TEXT,
  ADD COLUMN IF NOT EXISTS "failureMessage"        TEXT;

-- L'unicité de l'identifiant prestataire est ce qui rend un rejeu sûr : elle
-- interdit en BASE qu'un même virement soit ouvert deux fois, indépendamment de
-- tout `if` applicatif. Même garantie que `payments_provider_tx_uq`.
CREATE UNIQUE INDEX IF NOT EXISTS "Refund_providerRefundId_key"
  ON "Refund"("providerRefundId");

-- Sélection des remboursements à réconcilier auprès du prestataire.
CREATE INDEX IF NOT EXISTS "Refund_status_provider_idx"
  ON "Refund"("status", "provider");
