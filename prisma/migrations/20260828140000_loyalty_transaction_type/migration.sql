-- Déduplication du crédit de points de fidélité (fix M5, audit du 28/08/2026).
--
-- Deux chemins mènent une commande à LIVRER — PATCH /orders/:id/status et
-- PATCH /deliveries/:id/status — et chacun portait sa propre copie de
-- `awardLoyaltyPoints`, sans écriture conditionnelle : joués en concurrence, ils
-- créditaient deux fois. Aucune contrainte de base ne s'y opposait.
--
-- On qualifie donc chaque écriture du ledger par un `type`, et on pose un unique
-- (orderId, type). En PostgreSQL NULL != NULL : les lignes sans orderId (bonus de
-- parrainage) restent libres, ce qui est exactement voulu.

CREATE TYPE "LoyaltyTransactionType" AS ENUM (
  'ORDER_SPEND',
  'ORDER_EARN',
  'CANCELLATION_REFUND',
  'REFERRAL_REFERRER',
  'REFERRAL_REFERRED',
  'ADJUSTMENT'
);

ALTER TABLE "LoyaltyTransaction"
  ADD COLUMN "type" "LoyaltyTransactionType" NOT NULL DEFAULT 'ADJUSTMENT';

-- Reclassement des écritures existantes à partir du signe et du lien commande.
-- Les libellés sont ceux produits par le code depuis l'origine.
UPDATE "LoyaltyTransaction"
   SET "type" = 'ORDER_SPEND'
 WHERE "orderId" IS NOT NULL AND "points" < 0;

UPDATE "LoyaltyTransaction"
   SET "type" = 'CANCELLATION_REFUND'
 WHERE "orderId" IS NOT NULL AND "points" > 0 AND "reason" LIKE '%annulation%';

UPDATE "LoyaltyTransaction"
   SET "type" = 'ORDER_EARN'
 WHERE "orderId" IS NOT NULL AND "points" > 0 AND "type" = 'ADJUSTMENT';

UPDATE "LoyaltyTransaction"
   SET "type" = 'REFERRAL_REFERRER'
 WHERE "orderId" IS NULL AND "reason" LIKE 'Récompense parrainage%';

UPDATE "LoyaltyTransaction"
   SET "type" = 'REFERRAL_REFERRED'
 WHERE "orderId" IS NULL AND "reason" LIKE 'Bonus bienvenue parrainage%';

-- Dédoublonnage préalable : si un double crédit s'est déjà produit en
-- production, la contrainte refuserait de se créer. On conserve la plus
-- ancienne écriture de chaque couple (orderId, type) et on supprime les
-- suivantes. Le solde `User.loyaltyPoints` n'est PAS retouché ici : le
-- rattrapage éventuel relève d'un arbitrage humain (script de réconciliation).
DELETE FROM "LoyaltyTransaction" lt
 USING "LoyaltyTransaction" keep
 WHERE lt."orderId" IS NOT NULL
   AND lt."orderId" = keep."orderId"
   AND lt."type" = keep."type"
   AND (lt."createdAt" > keep."createdAt"
        OR (lt."createdAt" = keep."createdAt" AND lt."id" > keep."id"));

CREATE UNIQUE INDEX "LoyaltyTransaction_orderId_type_key"
  ON "LoyaltyTransaction"("orderId", "type");

CREATE INDEX "LoyaltyTransaction_userId_type_createdAt_idx"
  ON "LoyaltyTransaction"("userId", "type", "createdAt");
