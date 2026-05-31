-- Nettoyage des index manuels en doublon (LIL-111 — Sprint A)
--
-- Diagnostic via `pg_indexes` (29 mai 2026) :
-- - `idx_order_createdat` (DESC) doublonne `Order_createdAt_idx` (ASC) — un B-tree
--   sert les deux sens de tri, le doublon coûte des écritures sans bénéfice.
-- - `idx_order_status` doublonne `Order_status_idx`.
-- - `idx_payment_status` est l'équivalent attendu de `payments_status_idx` mais
--   créé manuellement avec une convention différente. On renomme plutôt que
--   drop+recreate pour éviter une fenêtre sans index.
--
-- Le schema déclare déjà @@index([status]) sur Payment (ajouté dans le même PR),
-- donc après le rename Prisma sera aligné.

DROP INDEX IF EXISTS "idx_order_createdat";
DROP INDEX IF EXISTS "idx_order_status";

ALTER INDEX IF EXISTS "idx_payment_status" RENAME TO "payments_status_idx";
