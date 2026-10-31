-- Durcissement lot 3 (30/10/2026) — parcours « accepter puis payer ».
--
-- ADDITIVE : colonnes avec défaut, aucune ligne réécrite. Toutes les commandes
-- existantes valent `PAY_FIRST` (défaut de colonne) ; le réglage plateforme
-- reste `PAY_FIRST` : le comportement de production est inchangé.
--
-- Vocabulaires en TEXT + CHECK (règle 14), liste miroir dans
-- `modules/orders/order-flow.ts`.
--
-- Rollback : revenir au code précédent suffit (il ignore ces colonnes). Ne
-- pas les supprimer si des commandes `ACCEPT_FIRST` existent : elles portent
-- leurs échéances.

ALTER TABLE "Order" ADD COLUMN "orderFlow" TEXT NOT NULL DEFAULT 'PAY_FIRST',
ADD COLUMN "paymentDueAt" TIMESTAMP(3),
ADD COLUMN "requestExpiresAt" TIMESTAMP(3);

ALTER TABLE "PlatformSettings" ADD COLUMN "acceptedPaymentWindowMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "minVendorAppVersion" TEXT,
ADD COLUMN "orderFlow" TEXT NOT NULL DEFAULT 'PAY_FIRST',
ADD COLUMN "vendorRequestTimeoutMinutes" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_orderFlow_known" CHECK ("orderFlow" IN ('PAY_FIRST', 'ACCEPT_FIRST')),
  -- Une demande n'existe que dans le nouveau parcours, avec son échéance.
  ADD CONSTRAINT "Order_request_needs_accept_first" CHECK (
    "status" <> 'DEMANDE_ENVOYEE'
    OR ("orderFlow" = 'ACCEPT_FIRST' AND "requestExpiresAt" IS NOT NULL)
  );

ALTER TABLE "PlatformSettings"
  ADD CONSTRAINT "PlatformSettings_orderFlow_known" CHECK ("orderFlow" IN ('PAY_FIRST', 'ACCEPT_FIRST')),
  ADD CONSTRAINT "PlatformSettings_vendorRequestTimeout_range" CHECK ("vendorRequestTimeoutMinutes" BETWEEN 1 AND 60),
  ADD CONSTRAINT "PlatformSettings_acceptedPaymentWindow_range" CHECK ("acceptedPaymentWindowMinutes" BETWEEN 2 AND 120);

-- Cron d'expiration des demandes sans réponse (`OrderRequestExpiryService`).
CREATE INDEX "Order_status_requestExpiresAt_idx" ON "Order"("status", "requestExpiresAt");
