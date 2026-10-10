-- D-4 (10/10/2026) — frais de service propres aux épiceries.
--
-- Additive : une colonne nullable sur la ligne unique de `PlatformSettings`.
-- `NULL` = le taux général s'applique, donc AUCUN changement de prix au
-- déploiement ; un administrateur pose le taux épicerie ensuite.
--
-- Points de base entiers (500 = 5 %), pas un pourcentage flottant (règle 5).
--
-- Retour arrière (après avoir remis le code précédent) :
--   ALTER TABLE "PlatformSettings" DROP CONSTRAINT "PlatformSettings_grocery_service_fee_range";
--   ALTER TABLE "PlatformSettings" DROP COLUMN "groceryServiceFeeBps";
-- Aucune donnée perdue au-delà du taux épicerie lui-même : les commandes
-- passées gardent leur `serviceFee` figé.

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "groceryServiceFeeBps" INTEGER;

-- Un taux de frais est compris entre 0 et 100 %.
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_grocery_service_fee_range" CHECK (
  "groceryServiceFeeBps" IS NULL
  OR ("groceryServiceFeeBps" >= 0 AND "groceryServiceFeeBps" <= 10000)
);
