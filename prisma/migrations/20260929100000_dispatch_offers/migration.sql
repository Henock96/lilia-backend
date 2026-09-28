-- F3-12.1-A — Dispatch semi-auto : table des offres de course.
--
-- Principe : cette migration **ne change aucun comportement**. Tout est
-- additif, avec des défauts neutres (`NULL`, `0`, `false`, `MANUAL`), et quatre
-- verrous restent fermés : `dispatchEnabled = false`, `dispatchMode = MANUAL`
-- sur chaque vendeur, `offersEnabledAt = NULL` sur chaque livreur, et le
-- trigger `DeliveryOffer_dispatch_enabled`, qui refuse toute insertion d'offre
-- tant que l'interrupteur est éteint — même par un script ou un bogue.
--
-- Aucun `ALTER TYPE … ADD VALUE` : la migration est entièrement
-- transactionnelle. Aucune valeur n'est ajoutée à `DeliveryStatus` (les apps
-- vendeurs rabattent toute valeur inconnue sur `enAttente`).
--
-- ⚠️ PRÉCONTRÔLE avant déploiement (lecture seule, base de production) :
--   SELECT "deliveryId", count(*) FROM "DeliveryAssignment"
--    WHERE "releasedAt" IS NULL GROUP BY 1 HAVING count(*) > 1;
-- doit rendre 0 ligne. Sinon, l'index `DeliveryAssignment_open_per_delivery_uq`
-- fait échouer la migration : c'est voulu, on ne le pose pas à l'aveugle.
--
-- ⚠️ `migrate diff` proposait aussi `DROP INDEX "Refund_status_provider_idx"` :
-- dérive préexistante entre migrations et schéma, hors de propos ici — retirée.

-- CreateEnum
CREATE TYPE "DeliveryOfferStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispatchMode" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "DispatchOutcome" AS ENUM ('ASSIGNED', 'EXHAUSTED', 'MANUAL_OVERRIDE', 'ORDER_CLOSED', 'STOPPED');

-- CreateEnum
CREATE TYPE "DispatchEndReason" AS ENUM ('NO_CANDIDATE', 'ROUNDS_EXHAUSTED', 'BUDGET_ELAPSED', 'PAY_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DispatchPickReason" AS ENUM ('LILIA_PRIORITY', 'INDEPENDENT_QUOTA', 'ONLY_LILIA', 'ONLY_INDEPENDENT');

-- CreateEnum
CREATE TYPE "OfferDeclineReason" AS ENUM ('TOO_FAR', 'END_OF_SHIFT', 'VEHICLE', 'OTHER');

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "dispatchDueAt" TIMESTAMP(3),
ADD COLUMN     "dispatchEndReason" "DispatchEndReason",
ADD COLUMN     "dispatchEndedAt" TIMESTAMP(3),
ADD COLUMN     "dispatchOutcome" "DispatchOutcome",
ADD COLUMN     "dispatchStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DriverProfile" ADD COLUMN     "consecutiveExpiredOffers" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "offersEnabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "dispatchAutoOfflineAfterExpired" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "dispatchEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dispatchIndependentEveryN" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "dispatchLeadMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "dispatchMaxRounds" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "dispatchMaxSearchMinutes" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "dispatchOfferSeconds" INTEGER NOT NULL DEFAULT 90;

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "dispatchMode" "DispatchMode" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "DeliveryOffer" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "status" "DeliveryOfferStatus" NOT NULL DEFAULT 'OFFERED',
    "round" INTEGER NOT NULL,
    "pickReason" "DispatchPickReason",
    "poolSize" INTEGER NOT NULL,
    "employmentType" "DriverEmploymentType" NOT NULL,
    "compensationModel" "DriverCompensationModel" NOT NULL,
    "baseXaf" INTEGER NOT NULL,
    "sharePercent" DOUBLE PRECISION,
    "payXaf" INTEGER NOT NULL,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "declineReason" "OfferDeclineReason",

    CONSTRAINT "DeliveryOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryOffer_deliveryId_offeredAt_idx" ON "DeliveryOffer"("deliveryId", "offeredAt");

-- CreateIndex
CREATE INDEX "DeliveryOffer_driverId_offeredAt_idx" ON "DeliveryOffer"("driverId", "offeredAt" DESC);

-- AddForeignKey
ALTER TABLE "DeliveryOffer" ADD CONSTRAINT "DeliveryOffer_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOffer" ADD CONSTRAINT "DeliveryOffer_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Invariants ───────────────────────────────────────────────────────────────
-- Colonnes neuves sur des tables vivantes : toutes les lignes existantes
-- portent NULL / 0 / les défauts, qui satisfont chaque CHECK.

ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_expired_offers_non_negative"
  CHECK ("consecutiveExpiredOffers" >= 0);

-- État de recherche dérivé : une fin a toujours une issue, un motif de fin
-- n'existe que pour une recherche épuisée, un début suppose une échéance.
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_dispatch_consistent" CHECK (
  (("dispatchEndedAt" IS NULL) = ("dispatchOutcome" IS NULL))
  AND ("dispatchEndReason" IS NULL OR "dispatchOutcome" = 'EXHAUSTED')
  AND ("dispatchStartedAt" IS NULL OR "dispatchDueAt" IS NOT NULL)
);

ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_dispatch_bounds" CHECK (
  "dispatchOfferSeconds" BETWEEN 30 AND 300
  AND "dispatchMaxRounds" BETWEEN 1 AND 5
  AND "dispatchMaxSearchMinutes" BETWEEN 1 AND 30
  AND "dispatchLeadMinutes" BETWEEN 0 AND 120
  AND "dispatchAutoOfflineAfterExpired" >= 1
  AND "dispatchIndependentEveryN" >= 0
);

ALTER TABLE "DeliveryOffer" ADD CONSTRAINT "DeliveryOffer_window_valid"
  CHECK ("expiresAt" > "offeredAt");

ALTER TABLE "DeliveryOffer" ADD CONSTRAINT "DeliveryOffer_round_pool_valid"
  CHECK ("round" >= 1 AND "poolSize" >= 1);

-- Snapshot économique : mêmes règles que `computeDriverCompensation`. Au
-- salaire, le taux est nul et la course rapporte 0 — un vrai zéro.
ALTER TABLE "DeliveryOffer" ADD CONSTRAINT "DeliveryOffer_pay_valid" CHECK (
  "baseXaf" >= 0 AND "payXaf" >= 0 AND "payXaf" <= "baseXaf"
  AND (("compensationModel" = 'SALARY') = ("sharePercent" IS NULL))
  AND ("sharePercent" IS NULL OR "sharePercent" BETWEEN 0 AND 100)
  AND ("compensationModel" <> 'SALARY' OR "payXaf" = 0)
);

-- Une offre ouverte n'a pas d'issue, une offre close en a une. Une
-- acceptation est datée avant l'échéance : I9 vérifiée par la base elle-même
-- (`respondedAt = now()` de la transaction qui accepte).
ALTER TABLE "DeliveryOffer" ADD CONSTRAINT "DeliveryOffer_response_valid" CHECK (
  (("status" = 'OFFERED') = ("respondedAt" IS NULL))
  AND ("status" <> 'ACCEPTED' OR "respondedAt" <= "expiresAt")
  AND ("declineReason" IS NULL OR "status" = 'DECLINED')
  AND ("seenAt" IS NULL OR "seenAt" >= "offeredAt")
);

-- I3 : au plus une offre ouverte par course (dispatch séquentiel, D9).
CREATE UNIQUE INDEX "DeliveryOffer_open_per_delivery_uq"
  ON "DeliveryOffer"("deliveryId") WHERE "status" = 'OFFERED';

-- I2 : au plus une offre ouverte par livreur. L'insertion passe par
-- `INSERT … ON CONFLICT DO NOTHING` : un P2002 avorterait la transaction.
CREATE UNIQUE INDEX "DeliveryOffer_open_per_driver_uq"
  ON "DeliveryOffer"("driverId") WHERE "status" = 'OFFERED';

-- Tick d'expiration : `WHERE status = 'OFFERED' AND "expiresAt" <= now()`.
CREATE INDEX "DeliveryOffer_open_expiry_idx"
  ON "DeliveryOffer"("expiresAt") WHERE "status" = 'OFFERED';

-- Quota « 1 sur N » du jour : ne compte que les 1ʳᵉˢ offres d'une recherche.
CREATE INDEX "DeliveryOffer_first_offer_day_idx"
  ON "DeliveryOffer"("offeredAt") WHERE "pickReason" IS NOT NULL;

-- Démarrages et reprises de recherche par le tick.
CREATE INDEX "Delivery_dispatch_pending_idx"
  ON "Delivery"("dispatchDueAt")
  WHERE "dispatchEndedAt" IS NULL AND "dispatchDueAt" IS NOT NULL;

-- I1 : une course a au plus une main ouverte. Seul objet de cette migration
-- qui contraint des lignes existantes (voir le précontrôle en tête).
CREATE UNIQUE INDEX "DeliveryAssignment_open_per_delivery_uq"
  ON "DeliveryAssignment"("deliveryId") WHERE "releasedAt" IS NULL;

-- I5/I6 : identité et snapshot immuables, statut terminal figé, horodatages
-- d'issue et de lecture écrits une seule fois. `IS DISTINCT FROM` sur des
-- tuples : `<>` laisserait passer `NULL → valeur` (`sharePercent`,
-- `pickReason`). Pas de trigger `BEFORE DELETE` : la CASCADE depuis
-- `Delivery` doit rester possible (scripts d'exploitation).
CREATE FUNCTION "f312_delivery_offer_immutable"() RETURNS trigger AS $$
BEGIN
  IF (NEW."id", NEW."deliveryId", NEW."driverId", NEW."round", NEW."pickReason",
      NEW."poolSize", NEW."employmentType", NEW."compensationModel", NEW."baseXaf",
      NEW."sharePercent", NEW."payXaf", NEW."offeredAt", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD."id", OLD."deliveryId", OLD."driverId", OLD."round", OLD."pickReason",
      OLD."poolSize", OLD."employmentType", OLD."compensationModel", OLD."baseXaf",
      OLD."sharePercent", OLD."payXaf", OLD."offeredAt", OLD."expiresAt")
  THEN
    RAISE EXCEPTION 'DeliveryOffer % : termes immuables', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'DeliveryOffer_terms_immutable';
  END IF;
  IF OLD."status" <> 'OFFERED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'DeliveryOffer % : statut terminal', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'DeliveryOffer_status_terminal';
  END IF;
  IF (OLD."seenAt" IS NOT NULL AND NEW."seenAt" IS DISTINCT FROM OLD."seenAt")
     OR (OLD."respondedAt" IS NOT NULL AND NEW."respondedAt" IS DISTINCT FROM OLD."respondedAt")
     OR (OLD."declineReason" IS NOT NULL AND NEW."declineReason" IS DISTINCT FROM OLD."declineReason")
  THEN
    RAISE EXCEPTION 'DeliveryOffer % : horodatage ou motif déjà posé', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'DeliveryOffer_stamp_once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DeliveryOffer_immutable"
  BEFORE UPDATE ON "DeliveryOffer"
  FOR EACH ROW EXECUTE FUNCTION "f312_delivery_offer_immutable"();

-- Quatrième verrou de rollout : aucune offre tant que l'interrupteur global
-- est éteint. Une ligne singleton absente vaut « éteint ». N'agit que sur
-- l'insertion : les offres déjà ouvertes restent honorables jusqu'à échéance.
CREATE FUNCTION "f312_delivery_offer_dispatch_enabled"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "dispatchEnabled" FROM "PlatformSettings" WHERE "id" = 'singleton') IS NOT TRUE THEN
    RAISE EXCEPTION 'Dispatch éteint : aucune offre ne peut être créée'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'DeliveryOffer_dispatch_enabled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DeliveryOffer_dispatch_enabled"
  BEFORE INSERT ON "DeliveryOffer"
  FOR EACH ROW EXECUTE FUNCTION "f312_delivery_offer_dispatch_enabled"();
