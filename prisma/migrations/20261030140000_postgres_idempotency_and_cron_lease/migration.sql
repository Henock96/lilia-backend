-- Durcissement lot 4 (30/10/2026) — idempotence et verrous de cron en PostgreSQL.
--
-- ADDITIVE : une colonne NULL, un réglage au défaut historique et deux tables
-- neuves ; aucune ligne réécrite.
-- Toutes les commandes existantes ont `idempotencyKey` NULL : l'index unique
-- les ignore (NULL ≠ NULL en PostgreSQL), sa création ne peut pas échouer.
--
-- Impact production : `CREATE UNIQUE INDEX` prend un verrou SHARE sur "Order"
-- (écritures suspendues le temps de la construction ; quelques milliers de
-- lignes, de l'ordre de la seconde au plus).
--
-- Rollback : revenir au code précédent suffit (il ignore colonne et tables).
-- Si besoin, après retour du code :
--   DROP INDEX "Order_userId_idempotencyKey_key";
--   ALTER TABLE "Order" DROP COLUMN "idempotencyKey";
--   DROP TABLE "CronLease"; DROP TABLE "IdempotencyReceipt";
--   ALTER TABLE "PlatformSettings" DROP COLUMN "vendorCanAssignDriver";

-- Une transaction longue ouverte sur "Order" ferait attendre l'ACCESS
-- EXCLUSIVE de l'ALTER, et toutes les lectures derrière lui : on échoue
-- proprement plutôt (rien n'est appliqué, `migrate deploy` peut être relancé).
SET lock_timeout = '5s';

ALTER TABLE "Order" ADD COLUMN "idempotencyKey" TEXT;

-- D-7 : vrai par défaut = comportement de production inchangé au déploiement.
ALTER TABLE "PlatformSettings" ADD COLUMN "vendorCanAssignDriver" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "CronLease" (
    "jobName" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronLease_pkey" PRIMARY KEY ("jobName")
);

CREATE TABLE "IdempotencyReceipt" (
    "scope" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyReceipt_pkey" PRIMARY KEY ("scope","ownerId","key")
);

-- Vocabulaire en TEXT + CHECK (règle 14) ; liste miroir :
-- `IDEMPOTENCY_SCOPES` dans `common/idempotency/idempotency-receipt.ts`.
ALTER TABLE "IdempotencyReceipt"
  ADD CONSTRAINT "IdempotencyReceipt_scope_known" CHECK ("scope" IN ('stock.restock'));

CREATE INDEX "IdempotencyReceipt_createdAt_idx" ON "IdempotencyReceipt"("createdAt");

CREATE UNIQUE INDEX "Order_userId_idempotencyKey_key" ON "Order"("userId", "idempotencyKey");
