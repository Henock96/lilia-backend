-- Audit du 28/10/2026, F-10 — rendre la trace des signaux de paiement exacte.
--
-- Additive : deux valeurs d'enum, aucune ligne existante modifiée.
--   · PaymentEventSource.ADMIN — confirmation manuelle d'un administrateur
--     (enregistrée jusqu'ici `WEBHOOK`) ;
--   · PaymentEventOutcome.FAILED_PROCESSING — signal enregistré dont le
--     traitement a levé (restait `APPLIED`).
--
-- ⚠️ `ALTER TYPE … ADD VALUE` : la nouvelle valeur n'est pas utilisable dans la
-- transaction qui l'ajoute. Aucune instruction de ce fichier ne l'utilise.
-- Les lignes historiques `WEBHOOK` + `provider = 'MANUAL'` ne sont PAS
-- réécrites : le compteur de santé les écarte par `provider = 'PAWAPAY'`.
--
-- Rollback : une valeur d'enum ne se retire pas sans recréer le type. On ne
-- la retire pas ; l'ancienne version applicative ne l'écrit simplement pas.

ALTER TYPE "PaymentEventSource" ADD VALUE IF NOT EXISTS 'ADMIN';
ALTER TYPE "PaymentEventOutcome" ADD VALUE IF NOT EXISTS 'FAILED_PROCESSING';
