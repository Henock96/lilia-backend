-- Onboarding vendeur (août 2026)
--
-- Sépare trois notions que le modèle confondait : un vendeur *créé* n'est pas
-- un vendeur *prêt*, qui n'est pas un vendeur *ouvert*. Jusqu'ici, valider le
-- formulaire d'admin publiait immédiatement une boutique vide, sans horaires,
-- sans GPS et sans produit — et le cron d'ouverture, qui ignore les vendeurs
-- sans horaires, la laissait « ouverte » 24 h/24.
--
-- ⚠️ Cette migration s'exécute sur une base de PRODUCTION portant des vendeurs
-- qui vendent déjà. Les étapes 2 et 3 existent uniquement pour eux : sans
-- elles, le nouveau défaut `onboardingStatus = DRAFT` les rendrait invisibles
-- et le nouveau cron les fermerait. Aucune ligne de Order, Payment, Product ou
-- User n'est lue ni écrite.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Structure — colonnes nullables ou avec défaut : aucune ligne invalidée
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'READY', 'ACTIVATED');

ALTER TABLE "Restaurant"
  ADD COLUMN "onboardingStatus"     "OnboardingStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "activatedAt"          TIMESTAMP(3),
  ADD COLUMN "activatedById"        TEXT,
  ADD COLUMN "description"          TEXT,
  ADD COLUMN "email"                TEXT,
  ADD COLUMN "imagePublicId"        TEXT,
  ADD COLUMN "quartierId"           TEXT,
  ADD COLUMN "deliveryInstructions" TEXT,
  ADD COLUMN "supportsDelivery"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "supportsPickup"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "commissionPercent"    DOUBLE PRECISION;

ALTER TABLE "Restaurant"
  ADD CONSTRAINT "Restaurant_quartierId_fkey"
  FOREIGN KEY ("quartierId") REFERENCES "Quartier"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Restaurant_onboardingStatus_adminApproved_isActive_idx"
  ON "Restaurant"("onboardingStatus", "adminApproved", "isActive");
CREATE INDEX "Restaurant_quartierId_idx" ON "Restaurant"("quartierId");

-- Snapshot de la commission sur la commande. `Restaurant.commissionPercent`
-- peut évoluer ; sans ce figement, changer le taux réécrirait rétroactivement
-- ce que la plateforme a prélevé sur des commandes déjà encaissées.
-- Défaut 0 : les commandes antérieures n'ont supporté aucune commission, et
-- c'est exactement ce que 0 exprime — ne pas leur inventer un taux a posteriori.
ALTER TABLE "Order"
  ADD COLUMN "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "commissionAmount"  DOUBLE PRECISION NOT NULL DEFAULT 0;

-- `IF NOT EXISTS` : un label d'enum ne peut pas être retiré en PostgreSQL. Sans
-- cette clause, un rejeu de la migration (échec réseau à mi-parcours, reprise
-- manuelle) meurt ici — c'est-à-dire AVANT les étapes 2 et 3, laissant tous les
-- vendeurs de production en `DRAFT`, donc invisibles du catalogue. Vérifié en
-- reproduisant le cas sur une base contenant des données.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_CREATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_ACTIVATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_COMMISSION_CHANGED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_CATALOG_EDITED';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Rattrapage : tout ce qui existe est déjà en production, donc ACTIVATED
--
-- Le défaut de la colonne est `DRAFT` parce que c'est le bon état pour une
-- création future. Appliqué tel quel à l'existant, il ferait disparaître du
-- catalogue des vendeurs qui prennent des commandes aujourd'hui.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE "Restaurant"
   SET "onboardingStatus" = 'ACTIVATED',
       "activatedAt"      = "createdAt";

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Rattrapage : horaires par défaut pour les vendeurs qui n'en ont aucun
--
-- Le cron cesse d'ignorer les vendeurs sans horaires — il les ferme. Sans cette
-- étape, tout vendeur actif jamais configuré fermerait à la minute suivant le
-- déploiement, sans que personne ne comprenne pourquoi. On leur pose donc une
-- plage large (07:00–22:00, 7 j/7) qu'ils pourront affiner : c'est une valeur
-- plausible pour la restauration à Brazzaville, et surtout un comportement
-- identique à celui d'avant la migration pour l'essentiel de la journée.
--
-- Restreint aux vendeurs actifs : un vendeur déjà suspendu n'a pas besoin
-- d'horaires, et lui en donner brouillerait la lecture de son état.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "OperatingHours" ("id", "restaurantId", "dayOfWeek", "openTime", "closeTime", "isClosed", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  r."id",
  d."day"::"DayOfWeek",
  '07:00',
  '22:00',
  false,
  NOW(),
  NOW()
FROM "Restaurant" r
CROSS JOIN (
  VALUES ('LUNDI'), ('MARDI'), ('MERCREDI'), ('JEUDI'),
         ('VENDREDI'), ('SAMEDI'), ('DIMANCHE')
) AS d("day")
WHERE r."isActive" = true
  AND NOT EXISTS (
    SELECT 1 FROM "OperatingHours" o WHERE o."restaurantId" = r."id"
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Défaut `isOpen` pour les créations FUTURES uniquement
--
-- Aucun UPDATE ici : changer `isOpen` sur l'existant fermerait des boutiques en
-- activité. Le défaut ne s'applique qu'aux lignes créées après cette migration,
-- que l'onboarding ouvrira au moment de l'activation.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Restaurant" ALTER COLUMN "isOpen" SET DEFAULT false;
