-- Dispatch FCFS (10/11/2026) — « premier arrivé, premier servi ».
--
-- ADDITIVE : deux colonnes NULL sur "Delivery" et un CHECK que toutes les
-- lignes existantes satisfont (NULL). Aucune ligne réécrite, aucun enum
-- touché, aucun objet F3-12 supprimé. Le comportement ne change pas tant que
-- `PlatformSettings.dispatchEnabled` reste `false` (défaut, inchangé ici).
--
-- Impact production : `ALTER TABLE … ADD COLUMN` sans défaut = catalogue
-- seul ; `ADD CONSTRAINT … CHECK` parcourt "Delivery" sous ACCESS EXCLUSIVE
-- (quelques milliers de lignes au plus, de l'ordre de la milliseconde).
--
-- Rollback : revenir au code précédent suffit (il ignore les deux colonnes).
-- Si besoin, après retour du code :
--   ALTER TABLE "Delivery" DROP CONSTRAINT "Delivery_dispatch_fcfs_counters";
--   ALTER TABLE "Delivery" DROP COLUMN "dispatchNotifiedCount";
--   ALTER TABLE "Delivery" DROP COLUMN "dispatchRound";

-- Une transaction longue ouverte sur "Delivery" ferait attendre l'ACCESS
-- EXCLUSIVE de l'ALTER, et toutes les lectures derrière lui : on échoue
-- proprement plutôt (rien n'est appliqué, `migrate deploy` peut être relancé).
SET lock_timeout = '5s';

ALTER TABLE "Delivery" ADD COLUMN "dispatchRound" INTEGER,
ADD COLUMN "dispatchNotifiedCount" INTEGER;

-- Compteurs : jamais négatifs. Le plafond de diffusions (5) est une règle de
-- code (`FCFS_MAX_ROUNDS`), pas une contrainte : il doit pouvoir évoluer sans
-- migration.
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_dispatch_fcfs_counters" CHECK (
  ("dispatchRound" IS NULL OR "dispatchRound" >= 0)
  AND ("dispatchNotifiedCount" IS NULL OR "dispatchNotifiedCount" >= 0)
);
