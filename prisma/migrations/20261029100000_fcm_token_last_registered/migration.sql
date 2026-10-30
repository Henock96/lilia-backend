-- Audit du 28/10/2026, F-03 — joignabilité des vendeurs.
--
-- Additive : une colonne avec défaut, aucune ligne supprimée ni réécrite hors
-- de cette colonne. Reprise : la dernière inscription connue est la création
-- (aucune autre date n'existe ; on n'en invente pas).
--
-- Rollback applicatif : l'ancienne version ignore la colonne. Ne pas la
-- supprimer en production : elle ne porte que des dates d'inscription.

ALTER TABLE "FcmToken"
  ADD COLUMN "lastRegisteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "FcmToken" SET "lastRegisteredAt" = "createdAt";
