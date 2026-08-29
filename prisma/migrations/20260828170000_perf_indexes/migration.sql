-- Index manquants relevés par l'audit du 28/08/2026 (M19 / P1) et assouplissement
-- de la contrainte d'unicité des avis.
--
-- Chaque index correspond à une requête réellement exécutée par le code, pas à
-- une précaution générale.

-- `GET /orders/my` : pagination des commandes d'un client, plus récentes d'abord.
CREATE INDEX IF NOT EXISTS "Order_userId_createdAt_idx"
  ON "Order"("userId", "createdAt" DESC);

-- `OrderExpiryService` : balaye toutes les 5 min les EN_ATTENTE anciennes.
CREATE INDEX IF NOT EXISTS "Order_status_createdAt_idx"
  ON "Order"("status", "createdAt");

-- `getReferralStats` : deux count() sur une colonne jusqu'ici non indexée, donc
-- deux scans complets de User à chaque ouverture de l'écran parrainage.
CREATE INDEX IF NOT EXISTS "User_referredByCode_idx"
  ON "User"("referredByCode");

-- Statistiques d'avis désormais calculées par groupBy(rating) côté PostgreSQL.
CREATE INDEX IF NOT EXISTS "Review_restaurantId_rating_idx"
  ON "Review"("restaurantId", "rating");

-- Un client ne pouvait laisser QU'UN avis par vendeur, ce qui contredisait le
-- flux « un avis par commande livrée » implémenté par ReviewsService (et faisait
-- remonter un 409 incompréhensible au client). L'unicité utile reste portée par
-- `Review.orderId @unique` ; l'unicité des avis sans commande est gardée par le
-- service.
DROP INDEX IF EXISTS "Review_userId_restaurantId_key";
