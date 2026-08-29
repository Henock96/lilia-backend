-- Séparation « mission acceptée » / « repas récupéré », et notation du livreur.
--
-- PROBLÈME CORRIGÉ : `acceptDelivery` faisait passer la livraison directement
-- de ASSIGNER à EN_TRANSIT, écrivait `pickedUpAt` et basculait la commande en
-- EN_ROUTE — le tout dans la même transaction. Le client recevait donc
-- « votre livreur est en chemin » à la seconde où le livreur acceptait la
-- mission, alors qu'il n'avait même pas quitté son domicile. Et `pickedUpAt`,
-- dont le sens est « quand le livreur a pris la commande », était faux en base.
--
-- Accepter une mission ≠ être en route vers le client.

-- ── 1. Nouvel état intermédiaire ────────────────────────────────────────────
-- ACCEPTER : le livreur a accepté et se rend au restaurant. Il n'a pas le repas.
-- EN_TRANSIT conserve son sens d'origine (le livreur roule AVEC le repas), qui
-- est aussi la condition du tracking GPS — on ne le redéfinit pas, on cesse de
-- l'attribuer trop tôt.
ALTER TYPE "DeliveryStatus" ADD VALUE 'ACCEPTER' AFTER 'ASSIGNER';

-- ── 2. Horodatage de l'acceptation ──────────────────────────────────────────
ALTER TABLE "Delivery" ADD COLUMN "acceptedAt" TIMESTAMP(3);

-- Les livraisons déjà EN_TRANSIT ont été acceptées ET récupérées au même
-- instant par l'ancien code : `pickedUpAt` est la meilleure approximation
-- disponible de leur acceptation. On ne les repasse PAS en ACCEPTER — elles
-- sont en cours, leur client suit déjà la course.
UPDATE "Delivery"
   SET "acceptedAt" = "pickedUpAt"
 WHERE "pickedUpAt" IS NOT NULL AND "acceptedAt" IS NULL;

-- ── 3. Notation du livreur ──────────────────────────────────────────────────
-- Table dédiée plutôt qu'extension de `Review` : `Review.orderId` est @unique,
-- y loger la note du livreur interdirait de noter le vendeur ET le livreur pour
-- la même commande.
CREATE TABLE "DeliveryReview" (
  "id"          TEXT NOT NULL,
  "deliveryId"  TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "delivererId" TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "rating"      INTEGER NOT NULL,
  "comment"     TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DeliveryReview_pkey" PRIMARY KEY ("id")
);

-- « Une note par livraison » est une règle métier : elle vit en base, pas
-- seulement dans le service.
CREATE UNIQUE INDEX "DeliveryReview_deliveryId_key" ON "DeliveryReview"("deliveryId");
CREATE INDEX "DeliveryReview_delivererId_createdAt_idx" ON "DeliveryReview"("delivererId", "createdAt" DESC);
CREATE INDEX "DeliveryReview_delivererId_rating_idx" ON "DeliveryReview"("delivererId", "rating");
CREATE INDEX "DeliveryReview_userId_idx" ON "DeliveryReview"("userId");

-- RESTRICT partout : une note est une trace, elle ne doit pas disparaître avec
-- une suppression accidentelle. La suppression de compte (DELETE /users/me)
-- anonymise la ligne User au lieu de la supprimer, la contrainte tient donc.
ALTER TABLE "DeliveryReview"
  ADD CONSTRAINT "DeliveryReview_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryReview"
  ADD CONSTRAINT "DeliveryReview_delivererId_fkey"
  FOREIGN KEY ("delivererId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryReview"
  ADD CONSTRAINT "DeliveryReview_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
