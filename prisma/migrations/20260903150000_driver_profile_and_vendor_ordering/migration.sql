-- Profil métier livreur + mise en ordre du catalogue (3 septembre 2026)
--
-- Deux chantiers dans une seule migration, délibérément : ils touchent deux
-- tables sans rapport, et les séparer imposerait deux fenêtres d'application
-- sur une base de production hébergée chez Neon pour un gain nul.
--
-- ⚠️ Cette migration s'exécute sur une base portant des livreurs qui LIVRENT
-- (2 comptes, 26 courses au 03/09) et des vendeurs qui VENDENT (6 comptes).
-- L'étape 3 existe uniquement pour eux : sans elle, le défaut
-- `DriverProfile.isActive = false` — voulu pour les créations futures — les
-- ferait disparaître de la file d'assignation dès le déploiement.
-- C'est le même piège que la migration `vendor_onboarding` d'août, où le
-- défaut `DRAFT` aurait dépublié tout le catalogue.
--
-- Aucune ligne n'est supprimée. Aucune colonne existante n'est modifiée.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Type véhicule
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VehicleType') THEN
    CREATE TYPE "VehicleType" AS ENUM ('MOTO', 'VELO', 'VOITURE', 'PIETON');
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Table DriverProfile
--
-- `isActive` naît à `false` : un livreur qu'on vient de créer n'a pas encore
-- été contrôlé. L'étape 3 rattrape l'existant.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "DriverProfile" (
  "id"                 TEXT NOT NULL,
  "userId"             TEXT NOT NULL,
  "vehicleType"        "VehicleType" NOT NULL DEFAULT 'MOTO',
  "plateNumber"        TEXT,
  "licenseNumber"      TEXT,
  "licenseExpiry"      TIMESTAMP(3),
  "isActive"           BOOLEAN NOT NULL DEFAULT false,
  "activatedAt"        TIMESTAMP(3),
  "activatedById"      TEXT,
  "deactivationReason" TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DriverProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DriverProfile_userId_key" ON "DriverProfile"("userId");
CREATE INDEX IF NOT EXISTS "DriverProfile_isActive_idx" ON "DriverProfile"("isActive");

ALTER TABLE "DriverProfile"
  DROP CONSTRAINT IF EXISTS "DriverProfile_userId_fkey";
ALTER TABLE "DriverProfile"
  ADD CONSTRAINT "DriverProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Table de liaison many-to-many implicite Prisma (`@relation("DriverZones")`).
-- Le nom `_DriverZones` et l'ordre alphabétique des colonnes A/B sont imposés
-- par Prisma : `DriverProfile` < `Quartier`, donc A = profil, B = quartier.
--
-- ⚠️ Clé PRIMAIRE composite, et non un index unique : c'est la forme qu'attend
-- Prisma 7. Avec un simple index unique, `migrate diff` signale un écart entre
-- les migrations et le schéma à chaque exécution — vérifié, puis corrigé.
CREATE TABLE IF NOT EXISTS "_DriverZones" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,

  CONSTRAINT "_DriverZones_AB_pkey" PRIMARY KEY ("A", "B")
);

CREATE INDEX IF NOT EXISTS "_DriverZones_B_index" ON "_DriverZones"("B");

ALTER TABLE "_DriverZones" DROP CONSTRAINT IF EXISTS "_DriverZones_A_fkey";
ALTER TABLE "_DriverZones"
  ADD CONSTRAINT "_DriverZones_A_fkey"
  FOREIGN KEY ("A") REFERENCES "DriverProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_DriverZones" DROP CONSTRAINT IF EXISTS "_DriverZones_B_fkey";
ALTER TABLE "_DriverZones"
  ADD CONSTRAINT "_DriverZones_B_fkey"
  FOREIGN KEY ("B") REFERENCES "Quartier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Rétro-création des profils des livreurs EXISTANTS
--
-- Sans cette étape, la règle « un livreur assignable a un profil actif »
-- (durcie dans `DeliveryAssignmentService`) rendrait tous les livreurs en
-- activité inassignables au premier redéploiement.
--
-- `isActive = true` et `activatedAt = User.createdAt` : ces comptes livrent
-- déjà, la plateforme les a de fait activés le jour de leur création.
-- `activatedById` reste NULL — personne n'a pris cette décision explicitement,
-- et inventer un auteur serait un faux dans un champ qui sert à répondre à
-- « qui a activé ce livreur ? ».
--
-- `vehicleType` retombe sur le défaut MOTO. C'est une hypothèse, pas une
-- certitude : à Brazzaville la moto est le cas dominant, et le champ est
-- corrigeable en un clic depuis le back-office. La seule alternative honnête
-- aurait été un `VehicleType.INCONNU`, qui aurait pollué l'enum pour toujours
-- afin de décrire deux lignes.
--
-- Idempotent (`ON CONFLICT DO NOTHING` + `WHERE NOT EXISTS`) : un rejeu partiel
-- de la migration ne duplique rien.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "DriverProfile" ("id", "userId", "vehicleType", "isActive", "activatedAt", "createdAt", "updatedAt")
SELECT
  'drv_' || substr(md5(random()::text || u."id"), 1, 21),
  u."id",
  'MOTO',
  true,
  u."createdAt",
  u."createdAt",
  CURRENT_TIMESTAMP
FROM "User" u
WHERE u."role" = 'LIVREUR'
  AND NOT EXISTS (SELECT 1 FROM "DriverProfile" d WHERE d."userId" = u."id")
ON CONFLICT ("userId") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Ordre d'affichage et mise en avant des vendeurs
--
-- Purement additif. `displayOrder = 1000` sur tout l'existant reproduit
-- exactement le comportement actuel : à valeur égale, le tri retombe sur le
-- critère secondaire (`createdAt DESC`), qui est celui d'aujourd'hui.
-- Personne ne voit de changement tant qu'un admin n'a rien classé.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Restaurant"
  ADD COLUMN IF NOT EXISTS "displayOrder" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS "isFeatured"   BOOLEAN NOT NULL DEFAULT false;

-- Nom tronqué par Prisma à 63 caractères (limite d'identifiant PostgreSQL).
-- Le reproduire tel quel évite un écart permanent dans `migrate diff`.
CREATE INDEX IF NOT EXISTS "Restaurant_onboardingStatus_adminApproved_isActive_displayO_idx"
  ON "Restaurant"("onboardingStatus", "adminApproved", "isActive", "displayOrder");

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Nouvelles actions du journal d'audit
--
-- `ALTER TYPE ... ADD VALUE` ne peut pas s'exécuter dans un bloc transactionnel
-- sur les anciennes versions de PostgreSQL ; `IF NOT EXISTS` rend le rejeu sûr.
-- Placé APRÈS les étapes de données, pour la même raison qu'en août : un rejeu
-- partiel qui mourrait ici laisserait le backfill non appliqué.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DRIVER_CREATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DRIVER_UPDATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DRIVER_ACTIVATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DRIVER_DEACTIVATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_DISPLAY_ORDER_CHANGED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_FEATURED_TOGGLED';
