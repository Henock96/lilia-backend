-- ════════════════════════════════════════════════════════════════════════════
-- PREMIUM S1 — grand livre : revenu des abonnements — 25 novembre 2026
--
-- Un abonnement payé par pawaPay entre dans le wallet du prestataire : sans
-- écriture, le solde `psp:PAWAPAY` du grand livre s'écarterait du wallet
-- (`WALLET_BALANCE_MISMATCH`, blocage GLOBAL des versements). L'écriture est
-- `COLLECTION` (genre existant) : débit `psp:PAWAPAY`, crédit d'un nouveau
-- compte de produit `revenue:subscription`.
--
-- ENTIÈREMENT ADDITIVE : la liste contrôlée `LedgerEntry.account` est ÉLARGIE
-- à `revenue:subscription` — sur-ensemble de l'ancienne, toute ligne existante
-- la satisfait. Aucune donnée lue ni réécrite. Verrou exclusif bref sur
-- `LedgerEntry` (écritures du poster en attente), vérification par `VALIDATE`
-- (laisse passer lectures et écritures), `lock_timeout` pour échouer plutôt
-- que bloquer.
--
-- ROLLBACK (APRÈS retour du code ; aucune écriture `revenue:subscription` —
-- sinon les contre-passer d'abord) :
--   BEGIN;
--   ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_account_known",
--     ADD CONSTRAINT "LedgerEntry_account_known" CHECK ("account" ~ '^(psp:[A-Z_]+|cash:manual|suspense:unmatched|clearing:order|vendor_payable|driver_payable|revenue:(service_fee|commission|delivery|forfeit)|expense:(platform_discount|refund_platform|driver_cost|psp_fee|vendor_adjustment))$');
--   DELETE FROM "_prisma_migrations"
--     WHERE migration_name = '20261125130000_ledger_subscription_revenue';
--   COMMIT;
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "LedgerEntry"
  DROP CONSTRAINT "LedgerEntry_account_known",
  ADD CONSTRAINT "LedgerEntry_account_known" CHECK ("account" ~ '^(psp:[A-Z_]+|cash:manual|suspense:unmatched|clearing:order|vendor_payable|driver_payable|revenue:(service_fee|commission|delivery|forfeit|subscription)|expense:(platform_discount|refund_platform|driver_cost|psp_fee|vendor_adjustment))$') NOT VALID;

ALTER TABLE "LedgerEntry" VALIDATE CONSTRAINT "LedgerEntry_account_known";

COMMIT;
