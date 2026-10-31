-- Durcissement lot 3 (30/10/2026) — membres d'une boutique (`ShopMembership`).
--
-- ADDITIVE : une table neuve, aucune colonne existante touchée. La reprise
-- crée UNE ligne OWNER ACTIVE par boutique depuis `Restaurant.ownerId`, qui
-- reste en place et continue d'autoriser (mode compatibilité) : aucun vendeur
-- ne perd un accès, aucun ne doit recréer son compte.
--
-- Vocabulaires en TEXT + CHECK (règle 14), liste miroir dans
-- `modules/vendors/shop-access.ts`.
--
-- Rollback : revenir au code précédent suffit (il ne lit que `ownerId`). Ne
-- pas supprimer la table si des membres MANAGER/STAFF ont été ajoutés depuis :
-- elle porte leur historique (invitation, révocation, motif).

CREATE TABLE "ShopMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invitedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "ShopMembership_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShopMembership_userId_status_idx" ON "ShopMembership"("userId", "status");
CREATE INDEX "ShopMembership_restaurantId_status_idx" ON "ShopMembership"("restaurantId", "status");

ALTER TABLE "ShopMembership" ADD CONSTRAINT "ShopMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopMembership" ADD CONSTRAINT "ShopMembership_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShopMembership"
  ADD CONSTRAINT "ShopMembership_role_known" CHECK ("role" IN ('OWNER', 'MANAGER', 'STAFF')),
  ADD CONSTRAINT "ShopMembership_status_known" CHECK ("status" IN ('INVITED', 'ACTIVE', 'REVOKED')),
  -- Révoqué ⇔ qui, quand.
  ADD CONSTRAINT "ShopMembership_revocation_complete" CHECK (
    ("status" = 'REVOKED') = ("revokedAt" IS NOT NULL AND "revokedBy" IS NOT NULL)
  );

-- Une adhésion vivante par (compte, boutique) : réinviter un membre révoqué
-- crée une nouvelle ligne, l'ancienne garde son historique.
CREATE UNIQUE INDEX "ShopMembership_user_shop_alive_uq"
  ON "ShopMembership"("userId", "restaurantId") WHERE "status" <> 'REVOKED';

-- Un seul propriétaire actif par boutique.
CREATE UNIQUE INDEX "ShopMembership_one_active_owner_uq"
  ON "ShopMembership"("restaurantId") WHERE "role" = 'OWNER' AND "status" = 'ACTIVE';

-- Reprise : le propriétaire actuel de chaque boutique. Rejouable sans doublon.
INSERT INTO "ShopMembership" ("id", "userId", "restaurantId", "role", "status", "createdAt", "activatedAt")
SELECT 'sm_' || replace(gen_random_uuid()::text, '-', ''), r."ownerId", r."id", 'OWNER', 'ACTIVE', now(), now()
  FROM "Restaurant" r
 WHERE r."ownerId" IS NOT NULL
ON CONFLICT DO NOTHING;
