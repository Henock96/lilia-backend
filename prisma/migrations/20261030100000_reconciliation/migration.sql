-- Durcissement, lot 2 (30/10/2026) — rapprochement Lilia ↔ prestataire.
--
-- ADDITIVE : trois tables neuves, aucune table existante touchée, aucune
-- donnée écrite. Rien n'est créé tant qu'un administrateur n'importe pas un
-- export ou ne lance pas un passage : sans élément ouvert, le contrôle des
-- versements (`ReconciliationService.payoutBlock`) ne bloque rien — le
-- comportement de production est inchangé au déploiement.
--
-- Vocabulaires en TEXT + CHECK (règle 14), listes miroir dans
-- `modules/ledger/reconciliation-rules.ts`.
--
-- ⚠️ ROLLBACK : ne pas supprimer ces tables une fois utilisées en production
-- (elles portent la piste d'audit des écarts résolus). Revenir à la version
-- applicative précédente suffit : plus rien ne les lit, plus rien ne bloque.

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PAWAPAY',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "sourceHash" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "walletBalanceXaf" INTEGER,
    "findingsCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationItem" (
    "id" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "blockScope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "restaurantId" TEXT,
    "orderId" TEXT,
    "paymentId" TEXT,
    "payoutId" TEXT,
    "refundId" TEXT,
    "externalId" TEXT,
    "expectedXaf" INTEGER,
    "actualXaf" INTEGER,
    "detail" TEXT NOT NULL,
    "firstRunId" TEXT,
    "lastRunId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolutionKind" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "ReconciliationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationItemEvent" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "runId" TEXT,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationItemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationRun_createdAt_idx" ON "ReconciliationRun"("createdAt");
CREATE UNIQUE INDEX "ReconciliationRun_provider_sourceHash_key" ON "ReconciliationRun"("provider", "sourceHash");
CREATE UNIQUE INDEX "ReconciliationItem_itemKey_key" ON "ReconciliationItem"("itemKey");
CREATE INDEX "ReconciliationItem_status_blockScope_restaurantId_idx" ON "ReconciliationItem"("status", "blockScope", "restaurantId");
CREATE INDEX "ReconciliationItem_type_status_idx" ON "ReconciliationItem"("type", "status");
CREATE INDEX "ReconciliationItemEvent_itemId_createdAt_idx" ON "ReconciliationItemEvent"("itemId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReconciliationItemEvent" ADD CONSTRAINT "ReconciliationItemEvent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ReconciliationItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReconciliationItemEvent" ADD CONSTRAINT "ReconciliationItemEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Vocabulaires ──────────────────────────────────────────────────────────

ALTER TABLE "ReconciliationRun"
  ADD CONSTRAINT "ReconciliationRun_kind_known" CHECK ("kind" IN ('PROVIDER_EXPORT', 'INTERNAL_SCAN')),
  -- Un export importé porte toujours son empreinte : c'est elle qui empêche
  -- de l'importer deux fois.
  ADD CONSTRAINT "ReconciliationRun_export_hashed" CHECK ("kind" <> 'PROVIDER_EXPORT' OR "sourceHash" IS NOT NULL),
  ADD CONSTRAINT "ReconciliationRun_period_ordered" CHECK ("periodStart" < "periodEnd");

ALTER TABLE "ReconciliationItem"
  ADD CONSTRAINT "ReconciliationItem_type_known" CHECK ("type" IN (
    'PROVIDER_ONLY', 'LILIA_ONLY', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH',
    'STATUS_CONFLICT', 'DUPLICATE_PROVIDER_ROW', 'FEE_UNKNOWN', 'FEE_MISMATCH',
    'REFUND_WITHOUT_PROOF', 'STALE_IN_FLIGHT', 'CLEARING_RESIDUAL',
    'WALLET_BALANCE_MISMATCH')),
  ADD CONSTRAINT "ReconciliationItem_severity_known" CHECK ("severity" IN ('CRITICAL', 'HIGH', 'MEDIUM')),
  ADD CONSTRAINT "ReconciliationItem_blockScope_known" CHECK ("blockScope" IN ('VENDOR', 'GLOBAL', 'NONE')),
  ADD CONSTRAINT "ReconciliationItem_status_known" CHECK ("status" IN ('OPEN', 'RESOLVED')),
  -- Un blocage « vendeur » sans vendeur ne bloquerait personne : il devient
  -- global plutôt que silencieux (le service le promeut ; la base le refuse).
  ADD CONSTRAINT "ReconciliationItem_vendor_block_has_vendor" CHECK ("blockScope" <> 'VENDOR' OR "restaurantId" IS NOT NULL),
  -- Résolu ⇔ qui, quand, comment et pourquoi. `COALESCE` : un CHECK qui vaut
  -- NULL passe — chaque terme doit être faux ou vrai, jamais inconnu.
  ADD CONSTRAINT "ReconciliationItem_resolution_complete" CHECK (
    ("status" = 'RESOLVED') = (
      "resolvedAt" IS NOT NULL
      AND "resolvedBy" IS NOT NULL
      AND COALESCE("resolutionKind" IN ('EXPLAINED', 'CORRECTED', 'WRITTEN_OFF'), false)
      AND COALESCE(length(btrim("resolutionNote")) >= 10, false)
    ));

ALTER TABLE "ReconciliationItemEvent"
  ADD CONSTRAINT "ReconciliationItemEvent_kind_known" CHECK ("kind" IN ('OPENED', 'REOPENED', 'RESOLVED', 'NOTE'));

-- ─── Journal en ajout seul (fonction du grand livre, migration 20261029140000)

CREATE TRIGGER "ReconciliationItemEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ReconciliationItemEvent"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
