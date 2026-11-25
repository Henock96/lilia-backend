-- ════════════════════════════════════════════════════════════════════════════
-- PREMIUM S1 — le vendeur paie son abonnement dans la plateforme — 25/11/2026
--
-- Le vendeur choisit 1, 3, 6 ou 12 mois depuis l'administration web et paie
-- par un dépôt pawaPay (MTN MoMo / Airtel Money). Le `SUCCESS` du prestataire
-- (webhook signé ou interrogation serveur) crée les mois (`VendorSubscription`,
-- une ligne par mois, `paymentMethod = 'PAWAPAY'`).
--
-- ADDITIVE, plus UNE écriture de données décidée par le propriétaire :
--   · table `SubscriptionPayment` (vide) ;
--   · `VendorSubscription.subscriptionPaymentId` (nullable ; aucune ligne en
--     prod au 25/11) ;
--   · CHECK `VendorSubscription_paymentMethod_check` élargi à 'PAWAPAY'
--     (supprimé puis recréé : toutes les valeurs existantes restent valides) ;
--   · prix mensuel Premium : 15 000 → 25 000 XAF (défaut ET ligne existante,
--     seulement si elle porte encore l'ancien défaut 15 000). Décision du
--     propriétaire du 25/11/2026 ; ensuite modifiable par une demande
--     approuvée (R-09). Aucun abonnement n'existe en prod (lu le 25/11).
--
-- Une ancienne instance du code tourne sans erreur sur ce schéma : elle ignore
-- la table et la colonne nouvelles.
--
-- ATOMIQUE (BEGIN/COMMIT) et borné : la clé étrangère vers "Restaurant" prend
-- un verrou sur une table que le cron d'ouverture touche chaque minute.
--
-- ROLLBACK (après retour du code, et seulement si aucune ligne PAWAPAY) :
--   BEGIN;
--   ALTER TABLE "VendorSubscription" DROP COLUMN "subscriptionPaymentId";
--   DROP TABLE "SubscriptionPayment";
--   ALTER TABLE "VendorSubscription" DROP CONSTRAINT "VendorSubscription_paymentMethod_check";
--   ALTER TABLE "VendorSubscription" ADD CONSTRAINT "VendorSubscription_paymentMethod_check"
--     CHECK ("paymentMethod" IN ('MOBILE_MONEY', 'CASH', 'BANK_TRANSFER', 'OTHER'));
--   ALTER TABLE "PlatformSettings" ALTER COLUMN "premiumMonthlyPriceXaf" SET DEFAULT 15000;
--   -- le prix n'est PAS remis à 15 000 : réglage financier (R-09), il se
--   -- redemande depuis l'admin web si le propriétaire le veut.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261125120000_premium_subscription_payments';
--   COMMIT;
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PlatformSettings" ALTER COLUMN "premiumMonthlyPriceXaf" SET DEFAULT 25000;

-- Décision du 25/11/2026 : 25 000 XAF. Ne réécrit pas un prix déjà réglé
-- autrement par une demande approuvée.
UPDATE "PlatformSettings"
   SET "premiumMonthlyPriceXaf" = 25000
 WHERE "premiumMonthlyPriceXaf" = 15000;

-- `PAWAPAY` : mois payé par le vendeur dans la plateforme.
ALTER TABLE "VendorSubscription" DROP CONSTRAINT "VendorSubscription_paymentMethod_check";
ALTER TABLE "VendorSubscription" ADD CONSTRAINT "VendorSubscription_paymentMethod_check"
  CHECK ("paymentMethod" IN ('MOBILE_MONEY', 'CASH', 'BANK_TRANSFER', 'OTHER', 'PAWAPAY'));

-- AlterTable
ALTER TABLE "VendorSubscription" ADD COLUMN     "subscriptionPaymentId" TEXT;

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'PREMIUM',
    "months" INTEGER NOT NULL,
    "unitPriceXaf" INTEGER NOT NULL,
    "amountXaf" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "phoneNumber" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "completedAt" TIMESTAMP(3),
    "collectionFeeXaf" INTEGER,
    "requestedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id"),
    -- Vocabulaires en TEXT + CHECK (règle 14) ; listes miroir dans
    -- `apps/lilia-app/src/modules/subscriptions/plans.ts`.
    CONSTRAINT "SubscriptionPayment_plan_check"
      CHECK ("plan" IN ('PREMIUM')),
    CONSTRAINT "SubscriptionPayment_status_check"
      CHECK ("status" IN ('PENDING', 'SUCCESS', 'FAILED')),
    CONSTRAINT "SubscriptionPayment_months_check"
      CHECK ("months" IN (1, 3, 6, 12)),
    CONSTRAINT "SubscriptionPayment_unitPrice_check"
      CHECK ("unitPriceXaf" > 0),
    -- Le montant débité ne peut pas diverger du prix figé (règle 5, entiers).
    CONSTRAINT "SubscriptionPayment_amount_check"
      CHECK ("amountXaf" = "months" * "unitPriceXaf"),
    CONSTRAINT "SubscriptionPayment_currency_check"
      CHECK ("currency" = 'XAF'),
    CONSTRAINT "SubscriptionPayment_fee_check"
      CHECK ("collectionFeeXaf" IS NULL OR "collectionFeeXaf" >= 0),
    -- Des mois ne s'accordent que sur un paiement abouti.
    CONSTRAINT "SubscriptionPayment_granted_check"
      CHECK ("grantedAt" IS NULL OR "status" = 'SUCCESS')
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_providerTransactionId_key" ON "SubscriptionPayment"("providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_reference_key" ON "SubscriptionPayment"("reference");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_status_createdAt_idx" ON "SubscriptionPayment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_restaurantId_createdAt_idx" ON "SubscriptionPayment"("restaurantId", "createdAt");

-- Une seule tentative en cours par vendeur : c'est la base qui arbitre deux
-- clics simultanés, pas un contrôle applicatif (même patron que
-- `payments_order_pending_uq`). Prisma ne sait pas déclarer un index partiel.
CREATE UNIQUE INDEX "SubscriptionPayment_one_pending_per_vendor"
  ON "SubscriptionPayment"("restaurantId") WHERE "status" = 'PENDING';

-- CreateIndex
CREATE INDEX "VendorSubscription_subscriptionPaymentId_idx" ON "VendorSubscription"("subscriptionPaymentId");

-- AddForeignKey
ALTER TABLE "VendorSubscription" ADD CONSTRAINT "VendorSubscription_subscriptionPaymentId_fkey" FOREIGN KEY ("subscriptionPaymentId") REFERENCES "SubscriptionPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
