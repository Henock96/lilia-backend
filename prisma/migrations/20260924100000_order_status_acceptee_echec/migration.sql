-- Phase 3, F3-01 / F3-05 — deux valeurs d'`OrderStatus`, dans UNE migration.
--
-- `ALTER TYPE … ADD VALUE` n'est pas transactionnel au sens où la valeur
-- ajoutée n'est utilisable qu'après commit : elle vit donc SEULE dans sa
-- migration (règle R5 du blueprint Phase 3). Les deux valeurs sont posées
-- ensemble pour ne payer ce coût qu'une fois.
--
--   ACCEPTEE         — le vendeur a accepté la commande payée (F3-01).
--   ECHEC_LIVRAISON  — terminal, le repas est parti et n'est pas arrivé
--                      (F3-05) ; aucune transition n'y mène encore.
--
-- `IF NOT EXISTS` : un rejeu partiel ne meurt pas sur la première valeur
-- (piège déjà rencontré par `20260830120000_vendor_onboarding`).
--
-- Aucune donnée n'est modifiée. Rollback : PostgreSQL ne sait pas retirer une
-- valeur d'enum ; laisser les valeurs en place est sans effet tant qu'aucune
-- ligne ne les porte.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ACCEPTEE' AFTER 'PAYER';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ECHEC_LIVRAISON' AFTER 'ANNULER';
