-- Preuve de remise d'une course (Master Audit v1, F-06).
--
-- Entièrement ADDITIVE : un type, une table, deux colonnes nullables. Aucune
-- ligne existante n'est réécrite — les courses en cours n'ont pas de code et
-- restent livrables (`handoverMethod = UNVERIFIED` à leur clôture). Une
-- instance de l'ancien code tourne sans erreur sur ce schéma.
--
-- Le code est rangé dans sa propre table et non dans `Delivery` : plusieurs
-- routes renvoient la ligne `Delivery` entière au livreur, qui ne doit jamais
-- voir le code qu'il est censé recevoir du client.
--
-- Rollback : DROP TABLE "DeliveryHandover"; puis supprimer les deux colonnes
-- et le type. Aucune donnée métier n'en dépend en dehors de la preuve.

CREATE TYPE "DeliveryHandoverMethod" AS ENUM ('CODE', 'ADMIN_OVERRIDE', 'UNVERIFIED');

ALTER TABLE "Delivery"
  ADD COLUMN "handoverMethod" "DeliveryHandoverMethod",
  ADD COLUMN "handoverVerifiedAt" TIMESTAMP(3);

CREATE TABLE "DeliveryHandover" (
    "deliveryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryHandover_pkey" PRIMARY KEY ("deliveryId")
);

ALTER TABLE "DeliveryHandover" ADD CONSTRAINT "DeliveryHandover_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
