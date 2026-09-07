-- Fidélité v2 + parrainage anti-fraude (7 septembre 2026)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ CETTE MIGRATION NE CHANGE PAS LA VALEUR DU POINT.
--
-- `loyaltyPointValueXaf` reste à sa valeur courante (5 XAF) sur la ligne
-- existante. Le passage à 50 XAF est fait par
-- `scripts/db/redenominate-loyalty.js`, **dans la même transaction** que la
-- division des soldes par 10.
--
-- Les séparer multiplierait par 10 tout le passif déjà distribué pendant la
-- fenêtre qui les sépare. Procédure complète : `docs/LOYALTY.md`.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('APPROVED', 'PENDING_REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeviceInstallationStatus" AS ENUM ('ACTIVE', 'FLAGGED', 'BLOCKED');

-- AlterEnum
-- `IF NOT EXISTS` : un rejeu partiel de la migration mourait sur la première
-- valeur déjà créée et laissait le reste non appliqué (leçon de
-- `20260830120000_vendor_onboarding`).
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'LOYALTY_ADJUSTED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PLATFORM_SETTINGS_CHANGED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'REFERRAL_REWARD_REVIEWED';

-- AlterTable — traçabilité de l'arbitrage de parrainage
ALTER TABLE "User" ADD COLUMN     "referralRewardOrderId" TEXT,
ADD COLUMN     "referralRewardedAt" TIMESTAMP(3);

-- AlterTable — le ledger sait désormais QUI a causé une écriture et QUI l'a passée
ALTER TABLE "LoyaltyTransaction" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "sourceUserId" TEXT;

-- AlterTable — la part « fidélité » de discountAmount, isolée
ALTER TABLE "Order" ADD COLUMN     "loyaltyDiscount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loyaltyPointsUsed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable — barème
ALTER TABLE "PlatformSettings" DROP COLUMN "loyaltyPointsPer100Xaf",
DROP COLUMN "referredBonusPoints",
ADD COLUMN     "loyaltyPointsPerOrder" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "loyaltyPointValueXaf" SET DEFAULT 50,
ALTER COLUMN "loyaltyMinRedemption" SET DEFAULT 1,
ALTER COLUMN "referrerBonusPoints" SET DEFAULT 1;

-- Les `SET DEFAULT` ci-dessus ne concernent que les futures installations : ils
-- ne touchent AUCUNE ligne existante. La ligne singleton de production porte
-- encore referrerBonusPoints = 500 et loyaltyMinRedemption = 100.
--
-- On les corrige donc explicitement, à deux exceptions près :
--   · `loyaltyPointValueXaf` — voir l'avertissement en tête de fichier ;
--   · `serviceFeePercent`   — hors périmètre, ne pas y toucher.
--
-- `referrerBonusPoints` DOIT passer à 1 dès maintenant : laissé à 500, le
-- premier filleul livré après ce déploiement offrirait 500 points à son parrain
-- sous le nouveau régime forfaitaire.
UPDATE "PlatformSettings"
   SET "referrerBonusPoints"   = 1,
       "loyaltyMinRedemption"  = 1,
       "loyaltyPointsPerOrder" = 1
 WHERE "id" = 'singleton';

-- Normalisation du téléphone : les comptes historiques ont été créés avec `''`
-- (chaîne vide) et non `NULL`. Cette distinction interdit toute contrainte
-- d'unicité future — `NULL` y échappe, `''` non — et fausse le signal
-- anti-abus `PHONE_REUSED`, qui compterait tous les comptes sans téléphone
-- comme partageant le même numéro.
--
-- Aucune donnée n'est perdue : `''` et `NULL` disent tous deux « pas de
-- téléphone ». La contrainte d'unicité elle-même n'est PAS posée ici — elle
-- attend le rapport de `scripts/db/audit-phone-duplicates.js`.
UPDATE "User" SET "phone" = NULL WHERE "phone" = '';

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "ReferralRewardStatus" NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "riskSignals" JSONB NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceInstallation" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "DeviceInstallationStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "DeviceInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- « Une seule récompense par filleul, à vie » et « une commande ne valide qu'un
-- seul parrainage » sont portées par la BASE, pas par un `if` applicatif : deux
-- passages concurrents à LIVRER produisent un P2002, jamais deux crédits.
CREATE UNIQUE INDEX "ReferralReward_referredUserId_key" ON "ReferralReward"("referredUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralReward_orderId_key" ON "ReferralReward"("orderId");

-- CreateIndex
CREATE INDEX "ReferralReward_referrerId_decidedAt_idx" ON "ReferralReward"("referrerId", "decidedAt" DESC);

-- CreateIndex
CREATE INDEX "ReferralReward_status_decidedAt_idx" ON "ReferralReward"("status", "decidedAt" DESC);

-- CreateIndex
CREATE INDEX "DeviceInstallation_installationId_idx" ON "DeviceInstallation"("installationId");

-- CreateIndex
CREATE INDEX "DeviceInstallation_userId_idx" ON "DeviceInstallation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceInstallation_installationId_userId_key" ON "DeviceInstallation"("installationId", "userId");

-- CreateIndex
CREATE INDEX "User_phone_idx" ON "User"("phone");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_sourceUserId_idx" ON "LoyaltyTransaction"("sourceUserId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_actorId_idx" ON "LoyaltyTransaction"("actorId");

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceInstallation" ADD CONSTRAINT "DeviceInstallation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
