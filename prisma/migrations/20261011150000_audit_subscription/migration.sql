-- ════════════════════════════════════════════════════════════════════════════
-- PREMIUM (Lot 2) — journal d'audit — 11 octobre 2026
--
-- ⚠️ `ADD VALUE` sur un type énuméré ne peut PAS tourner dans la même
-- transaction que son utilisation, sous PostgreSQL : migration isolée, jouée
-- avant `20261011150100_vendor_subscriptions`. Ces valeurs ne sont écrites que
-- par du code déployé APRÈS (« la migration part avant le code »).
--
-- `IF NOT EXISTS` : un rejeu partiel ne meurt pas sur une valeur déjà ajoutée.
--
-- ROLLBACK : aucun. PostgreSQL ne retire pas une valeur d'enum ; deux valeurs
-- inutilisées sont inoffensives.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_GRANTED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_REVOKED';
