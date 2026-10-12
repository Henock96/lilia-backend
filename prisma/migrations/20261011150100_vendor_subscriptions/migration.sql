-- ════════════════════════════════════════════════════════════════════════════
-- PREMIUM (Lot 2) — abonnements vendeur — 11 octobre 2026
--
-- Une ligne = une période d'abonnement PAYÉE hors plateforme et enregistrée
-- par un administrateur `FINANCE_EXECUTE`. Aucun droit n'est stocké ailleurs :
-- « Premium maintenant » se calcule sur cette table (`startsAt ≤ t < endsAt`,
-- statut ACTIVE). Pas de colonne sur `Restaurant`, pas de backfill.
--
-- ENTIÈREMENT ADDITIVE :
--   · une colonne avec défaut sur `PlatformSettings` (ligne `singleton`
--     existante → 15 000) ;
--   · une table vide.
-- Aucune donnée existante n'est lue, modifiée ou supprimée. Aucun vendeur ne
-- change de comportement : sans période enregistrée, tous restent Standard, et
-- rien n'est encore réservé au Premium (Lot 3).
--
-- Vocabulaires en TEXT + CHECK (règle 14) ; listes miroir dans
-- `apps/lilia-app/src/modules/subscriptions/plans.ts`.
--
-- ROLLBACK (si la feature est retirée) :
--   DROP TABLE "VendorSubscription";
--   ALTER TABLE "PlatformSettings" DROP COLUMN "premiumMonthlyPriceXaf";
-- ════════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "premiumMonthlyPriceXaf" INTEGER NOT NULL DEFAULT 15000;

ALTER TABLE "PlatformSettings"
  ADD CONSTRAINT "PlatformSettings_premiumMonthlyPriceXaf_positive"
  CHECK ("premiumMonthlyPriceXaf" > 0);

-- CreateTable
CREATE TABLE "VendorSubscription" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "priceXaf" INTEGER NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "paymentReference" TEXT,
    "note" TEXT,
    "requestKey" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "VendorSubscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VendorSubscription_plan_check"
      CHECK ("plan" IN ('PREMIUM')),
    CONSTRAINT "VendorSubscription_status_check"
      CHECK ("status" IN ('ACTIVE', 'REVOKED')),
    CONSTRAINT "VendorSubscription_paymentMethod_check"
      CHECK ("paymentMethod" IN ('MOBILE_MONEY', 'CASH', 'BANK_TRANSFER', 'OTHER')),
    CONSTRAINT "VendorSubscription_priceXaf_check"
      CHECK ("priceXaf" >= 0),
    CONSTRAINT "VendorSubscription_period_check"
      CHECK ("endsAt" > "startsAt"),
    -- Une révocation est complète ou n'existe pas : qui, quand, pourquoi.
    -- ACTIVE ⇒ les trois vides ; REVOKED ⇒ les trois renseignés.
    CONSTRAINT "VendorSubscription_revocation_check"
      CHECK (
        ("status" = 'ACTIVE'
          AND "revokedAt" IS NULL AND "revokedById" IS NULL AND "revokeReason" IS NULL)
        OR
        ("status" = 'REVOKED'
          AND "revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL)
      )
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorSubscription_requestKey_key" ON "VendorSubscription"("requestKey");

-- CreateIndex
CREATE INDEX "VendorSubscription_restaurantId_status_endsAt_idx" ON "VendorSubscription"("restaurantId", "status", "endsAt");

-- AddForeignKey
ALTER TABLE "VendorSubscription" ADD CONSTRAINT "VendorSubscription_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
