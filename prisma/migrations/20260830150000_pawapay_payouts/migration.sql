-- pawaPay : encaissement client (collection) ET reversement vendeur (payout).
--
-- Règle métier posée par ce chantier : **encaisser le client et payer le vendeur
-- sont deux mouvements d'argent distincts**, à deux moments différents, décidés
-- par deux acteurs différents. La base le reflète — `payments` d'un côté,
-- `restaurant_payouts` de l'autre, chacun avec son identifiant chez le
-- prestataire (`depositId` / `payoutId`).
--
-- Additive et non destructive : aucune colonne supprimée, aucune donnée
-- réécrite. Les commandes déjà passées n'ont simplement pas de reversement.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Valeurs d'énumération — TOUJOURS en premier
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `ADD VALUE IF NOT EXISTS`, et avant tout le reste : un rejeu partiel de la
-- migration `vendor_onboarding` était mort sur un `ADD VALUE` non idempotent
-- placé après ses UPDATE, laissant la production dans un état intermédiaire.
-- La leçon vaut ici : ces quatre valeurs ne sont utilisées par aucune
-- instruction de ce fichier, donc les ajouter en tête est sans risque.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PAYOUT_REQUESTED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PAYOUT_RETRIED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PAYOUT_CANCELLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_PAYOUT_ACCOUNT_UPDATED';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Nouveaux types
-- ─────────────────────────────────────────────────────────────────────────────

-- Opérateur du compte de reversement d'un vendeur. Distinct de `PaymentMethod`
-- (l'opérateur choisi par le client pour payer) : les deux répondent à des
-- questions différentes et n'évolueront pas ensemble.
CREATE TYPE "PayoutProvider" AS ENUM ('MTN_MOMO', 'AIRTEL_MONEY');

-- `SUCCESS` est le SEUL état où un vendeur est considéré comme payé.
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED');

CREATE TYPE "PaymentEventKind" AS ENUM ('COLLECTION', 'PAYOUT');
CREATE TYPE "PaymentEventSource" AS ENUM ('WEBHOOK', 'RECONCILIATION', 'CLIENT_POLL', 'INITIATION');
CREATE TYPE "PaymentEventOutcome" AS ENUM ('APPLIED', 'DUPLICATE', 'IGNORED', 'MISMATCH');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Configuration de la commission vendeur
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Défaut 10 %, mais rien ne fige ce taux : il est lu à chaque reversement,
-- surchargeable par vendeur (`Restaurant.commissionPercent`), et figé sur le
-- reversement lui-même. Il n'apparaît nulle part en dur dans le code.
--
-- ⚠️ Distinct de `serviceFeePercent` (8 %), qui est un frais payé EN PLUS par le
-- client. Celui-ci est retenu SUR le vendeur. Les confondre facturerait deux fois.
ALTER TABLE "PlatformSettings"
  ADD COLUMN "restaurantCommissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 10;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Coordonnées de reversement du vendeur
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Volontairement NULL pour tout l'existant : on n'infère pas un compte de
-- reversement depuis `Restaurant.phone` (numéro de contact) ni depuis le
-- téléphone du propriétaire. Envoyer de l'argent sur un numéro deviné n'est pas
-- rattrapable. Chaque vendeur devra être renseigné explicitement, et le
-- reversement est refusé tant qu'il ne l'est pas.
ALTER TABLE "Restaurant"
  ADD COLUMN "payoutPhoneNumber"  TEXT,
  ADD COLUMN "payoutProvider"     "PayoutProvider",
  ADD COLUMN "payoutAccountName"  TEXT,
  ADD COLUMN "payoutVerifiedAt"   TIMESTAMP(3),
  ADD COLUMN "payoutVerifiedById" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Encaissement : diagnostic et frais
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `completedAt` : `admin-payments.service.ts` mesurait le délai de validation
-- avec `updatedAt`, qui ment dès qu'une autre écriture touche la ligne.
-- `collectionFeeXaf` : frais du prestataire, CHARGE DE LILIA FOOD — jamais
-- déduits de ce que touche le vendeur.
ALTER TABLE "payments"
  ADD COLUMN "method"           "PaymentMethod",
  ADD COLUMN "failureCode"      TEXT,
  ADD COLUMN "failureMessage"   TEXT,
  ADD COLUMN "completedAt"      TIMESTAMP(3),
  ADD COLUMN "collectionFeeXaf" DOUBLE PRECISION;

-- Reprise de l'existant : les paiements déjà encaissés ont une date de
-- résolution connue (leur dernière écriture), et l'opérateur visé est celui de
-- la commande. Sans ce rattrapage, le KPI de délai et les filtres par opérateur
-- seraient vides sur tout l'historique.
UPDATE "payments"
SET "completedAt" = "updatedAt"
WHERE "status" IN ('SUCCESS', 'FAILED', 'CANCELLED')
  AND "completedAt" IS NULL;

UPDATE "payments" p
SET "method" = o."paymentMethod"
FROM "Order" o
WHERE p."orderId" = o."id"
  AND p."method" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Reversement vendeur
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Les cinq colonnes financières (`grossAmount`, `commissionPercent`,
-- `commissionAmount`, `amount`, `currency`) sont un SNAPSHOT : elles ne sont
-- jamais recalculées. Si le taux passe de 10 % à 12 %, un reversement d'hier
-- continue de dire 10 %. Même raison que `OrderItem.snapshotPrice`.
--
-- `phoneNumber` et `providerCode` sont figés pour la même raison : le vendeur
-- peut changer de numéro, cet envoi-ci est parti vers celui-là.
CREATE TABLE "restaurant_payouts" (
    "id"                    TEXT NOT NULL,
    "orderId"               TEXT NOT NULL,
    "restaurantId"          TEXT NOT NULL,

    "grossAmount"           DOUBLE PRECISION NOT NULL,
    "commissionPercent"     DOUBLE PRECISION NOT NULL,
    "commissionAmount"      DOUBLE PRECISION NOT NULL,
    "amount"                DOUBLE PRECISION NOT NULL,
    "currency"              TEXT NOT NULL DEFAULT 'XAF',

    "phoneNumber"           TEXT NOT NULL,
    "providerCode"          TEXT NOT NULL,

    "status"                "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "provider"              TEXT NOT NULL DEFAULT 'PAWAPAY',
    "providerPayoutId"      TEXT,
    "providerTransactionId" TEXT,

    "failureCode"           TEXT,
    "failureMessage"        TEXT,
    "payoutFeeXaf"          DOUBLE PRECISION,

    "requestedBy"           TEXT NOT NULL,
    "requestedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"           TIMESTAMP(3),

    "metadata"              JSONB NOT NULL DEFAULT '{}',
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_payouts_pkey" PRIMARY KEY ("id")
);

-- ⚠️ LA contrainte qui rend le double paiement impossible.
--
-- « Un vendeur n'est payé qu'une fois par commande » vit ici, en base, et non
-- dans un `if` du service : deux administrateurs cliquant à la même milliseconde
-- passeraient tous deux une vérification applicative. La seconde insertion
-- reçoit un P2002, que le service traduit en 409 « déjà payé ».
--
-- Un reversement FAILED est SUPPRIMÉ avant nouvelle tentative (cf.
-- RestaurantPayoutService.retry), ce qui préserve la contrainte tout en
-- autorisant le retry. L'historique de la tentative échouée survit dans
-- `PaymentEvent`, qui n'est jamais purgé.
CREATE UNIQUE INDEX "restaurant_payouts_orderId_key"
  ON "restaurant_payouts"("orderId");

CREATE INDEX "restaurant_payouts_restaurantId_status_idx"
  ON "restaurant_payouts"("restaurantId", "status");
CREATE INDEX "restaurant_payouts_status_requestedAt_idx"
  ON "restaurant_payouts"("status", "requestedAt");
CREATE INDEX "restaurant_payouts_restaurantId_completedAt_idx"
  ON "restaurant_payouts"("restaurantId", "completedAt");

-- Unicité de la référence prestataire, comme pour les encaissements : le
-- webhook de reversement doit retrouver une ligne et une seule.
CREATE UNIQUE INDEX "restaurant_payouts_provider_payout_uq"
  ON "restaurant_payouts" ("provider", "providerPayoutId")
  WHERE "providerPayoutId" IS NOT NULL;

ALTER TABLE "restaurant_payouts"
  ADD CONSTRAINT "restaurant_payouts_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "restaurant_payouts"
  ADD CONSTRAINT "restaurant_payouts_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Journal des signaux prestataire
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Append-only. Sert à trois choses que ni `payments` ni `restaurant_payouts` ne
-- peuvent rendre : la preuve de ce que le prestataire a envoyé (leur `metadata`
-- est écrasé à chaque écriture), la détection des callbacks reçus HORS ORDRE,
-- et le rejeu d'un callback perdu sans le redemander.
CREATE TABLE "PaymentEvent" (
    "id"         TEXT NOT NULL,
    "paymentId"  TEXT,
    "payoutId"   TEXT,
    "kind"       "PaymentEventKind" NOT NULL,
    "provider"   TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "source"     "PaymentEventSource" NOT NULL,
    "rawStatus"  TEXT NOT NULL,
    "payload"    JSONB NOT NULL,
    "outcome"    "PaymentEventOutcome" NOT NULL DEFAULT 'APPLIED',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentEvent_provider_externalId_idx"
  ON "PaymentEvent"("provider", "externalId");
CREATE INDEX "PaymentEvent_paymentId_receivedAt_idx"
  ON "PaymentEvent"("paymentId", "receivedAt");
CREATE INDEX "PaymentEvent_payoutId_receivedAt_idx"
  ON "PaymentEvent"("payoutId", "receivedAt");
CREATE INDEX "PaymentEvent_outcome_receivedAt_idx"
  ON "PaymentEvent"("outcome", "receivedAt");

-- `SET NULL` et non `CASCADE` : si une ligne de paiement disparaissait un jour,
-- la preuve de ce que le prestataire a annoncé doit lui survivre.
ALTER TABLE "PaymentEvent"
  ADD CONSTRAINT "PaymentEvent_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentEvent"
  ADD CONSTRAINT "PaymentEvent_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "restaurant_payouts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
