-- Durcissement lot 3 (30/10/2026) — parcours « accepter puis payer ».
--
-- `ALTER TYPE … ADD VALUE` : la valeur n'est utilisable qu'après commit, elle
-- vit donc SEULE dans sa migration (règle R5 du blueprint Phase 3, précédent
-- `20260924100000_order_status_acceptee_echec`). `IF NOT EXISTS` : un rejeu
-- partiel ne meurt pas.
--
--   DEMANDE_ENVOYEE — la demande attend la réponse du vendeur ; rien n'est
--                     encaissable. Atteint seulement en `ACCEPT_FIRST`.
--
-- Aucune donnée modifiée. Rollback : PostgreSQL ne retire pas une valeur
-- d'enum ; la laisser est sans effet tant qu'aucune ligne ne la porte (le
-- réglage `orderFlow` reste `PAY_FIRST` par défaut).

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DEMANDE_ENVOYEE' BEFORE 'EN_ATTENTE';
