-- Performance indexes (LFD-9 / IMP-10)
--
-- Deux groupes :
--   1. Index composites B-tree, declares dans schema.prisma via @@index
--      => geres par Prisma, pas de drift.
--   2. Index trigram pour la recherche texte, NON modelisables dans le schema
--      Prisma => geres manuellement (cf. note plus bas).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Index composites B-tree
-- ─────────────────────────────────────────────────────────────────────────────

-- Historique fidelite d'un user, plus recent en premier
-- (GET /users/me/loyalty : WHERE userId = ? ORDER BY createdAt DESC)
CREATE INDEX "LoyaltyTransaction_userId_createdAt_idx"
  ON "LoyaltyTransaction" ("userId", "createdAt" DESC);

-- Dashboard restaurateur : ses commandes filtrees par statut, plus recentes
-- (GET /orders/restaurant : WHERE restaurantId = ? AND status = ? ORDER BY createdAt DESC)
CREATE INDEX "Order_restaurantId_status_createdAt_idx"
  ON "Order" ("restaurantId", "status", "createdAt" DESC);

-- Missions d'un livreur filtrees par statut
-- (GET /deliveries/mine : WHERE delivererId = ? AND status = ?)
CREATE INDEX "Delivery_delivererId_status_idx"
  ON "Delivery" ("delivererId", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Index trigram pour la recherche (/products/search)
--
-- ATTENTION — deviation vs spec initiale du ticket :
-- Le ticket recommandait un index GIN `to_tsvector('french', ...)`. Or le code
-- de ProductsService.search() utilise Prisma `contains` { mode: 'insensitive' }
-- qui genere du SQL `ILIKE '%term%'`. Un index GIN to_tsvector n'est JAMAIS
-- utilise par le planificateur pour une requete ILIKE avec wildcard initial.
--
-- L'index correct pour accelerer `ILIKE '%...%'` est un index GIN base sur
-- l'extension pg_trgm (trigrammes) avec l'operator class gin_trgm_ops.
--
-- Ces objets ne sont pas modelisables dans schema.prisma : ils sont donc
-- "Prisma-unmanaged". Future migration : utiliser `prisma migrate dev
-- --create-only` puis verifier que ces CREATE INDEX ne sont pas supprimes.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Produits : recherche sur le nom et la description
CREATE INDEX "Product_nom_trgm_idx"
  ON "Product" USING GIN ("nom" gin_trgm_ops);

CREATE INDEX "Product_description_trgm_idx"
  ON "Product" USING GIN ("description" gin_trgm_ops);

-- Restaurants : recherche sur le nom
CREATE INDEX "Restaurant_nom_trgm_idx"
  ON "Restaurant" USING GIN ("nom" gin_trgm_ops);
