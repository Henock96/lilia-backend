-- Lot B (15/11/2026) — valeurs d'audit de la modération des avis, SEULES dans
-- leur migration : `ALTER TYPE … ADD VALUE` ne peut pas être suivi, dans la
-- même transaction, d'une écriture qui utilise la valeur (précédent :
-- 20260925170000_admin_audit_approvals_values).
--
-- Rollback : PostgreSQL ne retire pas une valeur d'enum ; le code précédent
-- l'ignore. Rien à défaire.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'REVIEW_HIDDEN';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'REVIEW_UNHIDDEN';
