-- F3-08 — capacités d'administrateur et approbations à deux (4 yeux).

-- CreateEnum
CREATE TYPE "AdminCapability" AS ENUM ('FINANCE_EXECUTE', 'FINANCE_APPROVE', 'USER_ROLES', 'SETTINGS', 'SUPPORT');
CREATE TYPE "ApprovalKind" AS ENUM ('PAYOUT_ACCOUNT_CHANGE', 'REFUND_EXECUTION', 'CAPABILITY_GRANT');
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "adminCapabilities" "AdminCapability"[] NOT NULL DEFAULT ARRAY[]::"AdminCapability"[];

-- Amorçage : les ADMIN existants reçoivent TOUTES les capacités. Rien ne
-- change au déploiement ; toute attribution ultérieure passe par deux admins.
UPDATE "User"
   SET "adminCapabilities" = ARRAY['FINANCE_EXECUTE', 'FINANCE_APPROVE', 'USER_ROLES', 'SETTINGS', 'SUPPORT']::"AdminCapability"[]
 WHERE "role" = 'ADMIN';

-- CreateTable
CREATE TABLE "FinancialApproval" (
    "id" TEXT NOT NULL,
    "kind" "ApprovalKind" NOT NULL,
    "refId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "amountXaf" INTEGER,
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "FinancialApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinancialApproval_status_createdAt_idx" ON "FinancialApproval"("status", "createdAt");

-- R-08.4 — celui qui demande n'approuve jamais : c'est la base qui le refuse.
ALTER TABLE "FinancialApproval" ADD CONSTRAINT "FinancialApproval_four_eyes"
  CHECK ("approvedBy" IS NULL OR "approvedBy" <> "requestedBy");

-- Une décision a un auteur ; une consommation suppose une approbation.
ALTER TABLE "FinancialApproval" ADD CONSTRAINT "FinancialApproval_decision_consistent"
  CHECK (
    ("status" = 'PENDING' AND "approvedBy" IS NULL AND "decidedAt" IS NULL)
    OR ("status" = 'EXPIRED' AND "approvedBy" IS NULL)
    OR ("status" IN ('APPROVED', 'REJECTED') AND "approvedBy" IS NOT NULL AND "decidedAt" IS NOT NULL)
    OR ("status" = 'CONSUMED' AND "approvedBy" IS NOT NULL AND "consumedAt" IS NOT NULL)
  );

-- Une seule demande en attente par objet et par nature : deux demandes
-- concurrentes sur le même numéro de versement seraient deux vérités.
CREATE UNIQUE INDEX "FinancialApproval_pending_uq" ON "FinancialApproval"("kind", "refId")
  WHERE "status" = 'PENDING';
