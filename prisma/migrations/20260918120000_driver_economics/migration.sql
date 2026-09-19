-- ════════════════════════════════════════════════════════════════════════════
-- ÉCONOMIE DE LA COURSE — 18 septembre 2026
--
-- Rend calculable le coût d'une livraison, qui n'existait nulle part : ni
-- colonne, ni table, ni règle. `contributionMargin` valait `null` sur toute
-- commande livrée faute de ce poste.
--
-- Décisions métier arbitrées le 18/09/2026 (PHASE2_2026-09-17, §22) :
--   D-1  part par livraison seule            → pas de table de paie
--   D-2  indépendant : 65 % livreur / 35 % Lilia
--   D-3  seul le livreur qui TERMINE est payé → pas de table de tentatives
--   D-4  part calculée sur le tarif AVANT remise commerciale
--
-- ⚠️ ORDRE DES INSTRUCTIONS — les types AVANT les colonnes qui les utilisent.
-- Un rejeu partiel qui mourrait entre les deux laisserait des colonnes
-- référençant un type absent. C'est le piège qui avait laissé toute la
-- production en `DRAFT` lors de la migration `vendor_onboarding`.
--
-- ENTIÈREMENT ADDITIVE : une instance de l'ancien code tourne dessus sans
-- rien voir. Aucune donnée détruite, aucune colonne supprimée.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Types ────────────────────────────────────────────────────────────────

-- Qui supporte les coûts du véhicule. Un INDEPENDENT apporte sa moto et paie
-- carburant, entretien et assurance : ces coûts ne sont jamais des charges de
-- Lilia Food, et n'ont donc aucune colonne dans ce schéma.
CREATE TYPE "DriverEmploymentType" AS ENUM ('LILIA', 'INDEPENDENT');

-- Les trois valeurs existent alors qu'une seule est utilisée (PER_DELIVERY).
-- C'est cet enum qui distingue « 0 parce qu'il est au salaire » de « inconnu ».
-- Sans lui, un zéro serait ambigu — et confondre « gratuit » et « on ne sait
-- pas » produit une marge surestimée avec l'air d'être exacte.
CREATE TYPE "DriverCompensationModel" AS ENUM ('SALARY', 'PER_DELIVERY', 'SALARY_PLUS_PER_DELIVERY');

-- ── 2. Taux plateforme ──────────────────────────────────────────────────────
--
-- Ces colonnes portent la part DU LIVREUR, jamais celle de Lilia. La part de
-- Lilia n'est pas stockée : elle vaut `base - driverPay`. Un résidu ne peut pas
-- diverger de son complément, deux colonnes si.
ALTER TABLE "PlatformSettings"
  ADD COLUMN "driverSharePercentLilia"       DOUBLE PRECISION NOT NULL DEFAULT 35,
  ADD COLUMN "driverSharePercentIndependent" DOUBLE PRECISION NOT NULL DEFAULT 65;

-- ── 3. Profil livreur ───────────────────────────────────────────────────────
--
-- Les deux livreurs existants prennent les défauts : LILIA / PER_DELIVERY, et
-- `driverSharePercent` reste NULL (= taux plateforme). Aucune décision ne leur
-- est imposée par la migration.
ALTER TABLE "DriverProfile"
  ADD COLUMN "employmentType"     "DriverEmploymentType"    NOT NULL DEFAULT 'LILIA',
  ADD COLUMN "compensationModel"  "DriverCompensationModel" NOT NULL DEFAULT 'PER_DELIVERY',
  ADD COLUMN "driverSharePercent" DOUBLE PRECISION;

-- ── 4. Assiette du partage, sur la commande ─────────────────────────────────
--
-- `deliveryFee` porte le tarif APRÈS remise : un code FREE_DELIVERY le met à 0.
-- Rémunérer le livreur dessus lui ferait porter une campagne marketing qu'il
-- n'a pas décidée. Cette colonne porte le tarif brut.
ALTER TABLE "Order"
  ADD COLUMN "deliveryFeeGross" INTEGER NOT NULL DEFAULT 0;

-- ⚠️ CE BACKFILL EST OBLIGATOIRE.
--
-- Le DEFAULT 0 ne vaut que pour les lignes futures : sans cet UPDATE, les 124
-- commandes existantes porteraient un tarif brut nul, et toute rémunération
-- calculée dessus vaudrait 0.
--
-- L'égalité `gross = deliveryFee` est EXACTE sur tout l'historique : vérifié en
-- production le 17/09/2026, les 3 seules commandes `isDelivery = true` avec
-- `deliveryFee = 0` sont TOUTES annulées (dont 2 par un code FREE_DELIVERY), et
-- aucune n'a atteint une livraison. Aucune course payable n'est donc concernée
-- par l'écart entre brut et net.
UPDATE "Order" SET "deliveryFeeGross" = "deliveryFee";

-- ── 5. Snapshot économique de la course ─────────────────────────────────────
--
-- Toutes nullables, et AUCUN BACKFILL — délibérément.
--
-- Poser rétroactivement 35 % sur les 26 courses déjà livrées fabriquerait des
-- montants qui n'ont jamais été versés à personne. Leur économie est inconnue :
-- `NULL` le dit, et `contributionMargin` continuera de valoir `null` sur ces
-- commandes-là. C'est exact, et c'est préférable à un chiffre inventé.
ALTER TABLE "Delivery"
  ADD COLUMN "driverBaseXaf"           INTEGER,
  ADD COLUMN "driverCompensationModel" "DriverCompensationModel",
  ADD COLUMN "driverEmploymentType"    "DriverEmploymentType",
  ADD COLUMN "driverSharePercent"      DOUBLE PRECISION,
  ADD COLUMN "driverPayXaf"            INTEGER,
  ADD COLUMN "driverEconomicsFrozenAt" TIMESTAMP(3);
