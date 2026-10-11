-- R-09 (11/10/2026) — les réglages qui fixent de l'argent passent par une
-- approbation à deux administrateurs : réglages de plateforme financiers et
-- commission propre à un vendeur.
--
-- Seules dans leur migration : `ALTER TYPE … ADD VALUE` ne se rejoue pas dans
-- une transaction avec d'autres ordres (précédent :
-- 20260924150100_audit_vendor_pause). `IF NOT EXISTS` rend le rejeu sûr.
--
-- Aucune table ni aucune ligne touchée.
--
-- Retour arrière : PostgreSQL ne retire pas une valeur d'enum. Si le code R-09
-- est retiré, les deux valeurs restent inertes (aucune ligne ne les porte tant
-- qu'aucune demande n'a été faite) ; ne rien faire en base.
ALTER TYPE "ApprovalKind" ADD VALUE IF NOT EXISTS 'PLATFORM_SETTINGS_CHANGE';
ALTER TYPE "ApprovalKind" ADD VALUE IF NOT EXISTS 'VENDOR_COMMISSION_CHANGE';
