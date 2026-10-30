-- Durcissement, lot 2 (30/10/2026) — grand livre financier en partie double.
--
-- ADDITIVE : quatre tables neuves, aucune table existante touchée, aucune
-- donnée écrite. Le grand livre est alimenté ensuite par le posteur
-- applicatif (`LedgerPosterService`), éteint par défaut.
--
-- Garanties portées par la base, pas seulement par le code :
--  1. vocabulaires bornés (CHECK, règle 14 — listes miroir dans
--     `modules/ledger/ledger-accounts.ts`) ;
--  2. chaque transaction est ÉQUILIBRÉE (somme des lignes = 0) et porte au
--     moins deux lignes — vérifié en fin de transaction (trigger différé) ;
--  3. AJOUT SEUL : `UPDATE` et `DELETE` refusés sur les deux tables. Une
--     correction est une contre-passation (`reversesTxId`, unique).
--
-- ⚠️ ROLLBACK : ne JAMAIS supprimer ces tables une fois alimentées en
-- production. En cas de problème : couper le posteur
-- (`LEDGER_POSTING_ENABLED=false`) et revenir à la version applicative
-- précédente ; les données restent. `TRUNCATE` reste techniquement possible
-- (opération d'exploitation, pas un chemin applicatif) — le réserver aux bases
-- de test.

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceEventKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "postingMode" TEXT NOT NULL DEFAULT 'LIVE',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "reversesTxId" TEXT,
    "evidenceRef" TEXT,
    "note" TEXT,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "txId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "amountXaf" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XAF',

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerPostingException" (
    "id" TEXT NOT NULL,
    "sourceEventKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "LedgerPostingException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerExcludedOrder" (
    "orderId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerExcludedOrder_pkey" PRIMARY KEY ("orderId")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_sourceEventKey_key" ON "LedgerTransaction"("sourceEventKey");
CREATE UNIQUE INDEX "LedgerTransaction_reversesTxId_key" ON "LedgerTransaction"("reversesTxId");
CREATE INDEX "LedgerTransaction_sourceType_sourceId_idx" ON "LedgerTransaction"("sourceType", "sourceId");
CREATE INDEX "LedgerTransaction_occurredAt_idx" ON "LedgerTransaction"("occurredAt");
CREATE INDEX "LedgerEntry_account_subjectId_idx" ON "LedgerEntry"("account", "subjectId");
CREATE INDEX "LedgerEntry_txId_idx" ON "LedgerEntry"("txId");
CREATE UNIQUE INDEX "LedgerPostingException_sourceEventKey_key" ON "LedgerPostingException"("sourceEventKey");

-- AddForeignKey
ALTER TABLE "LedgerTransaction" ADD CONSTRAINT "LedgerTransaction_reversesTxId_fkey" FOREIGN KEY ("reversesTxId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_txId_fkey" FOREIGN KEY ("txId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 1. Vocabulaires (CHECK) ────────────────────────────────────────────────

ALTER TABLE "LedgerTransaction"
  ADD CONSTRAINT "LedgerTransaction_kind_known" CHECK ("kind" IN (
    'COLLECTION', 'ACQUISITION', 'DRIVER_COST', 'REFUND', 'PAYOUT',
    'PSP_FEE', 'DRIVER_SETTLEMENT', 'VENDOR_ADJUSTMENT', 'REVERSAL')),
  ADD CONSTRAINT "LedgerTransaction_origin_known" CHECK ("origin" IN (
    'WEBHOOK', 'RECONCILIATION', 'CLIENT_POLL', 'INITIATION', 'ADMIN',
    'SYSTEM', 'UNKNOWN')),
  ADD CONSTRAINT "LedgerTransaction_postingMode_known" CHECK ("postingMode" IN ('LIVE', 'BACKFILL')),
  ADD CONSTRAINT "LedgerTransaction_reversal_linked" CHECK (
    ("kind" = 'REVERSAL') = ("reversesTxId" IS NOT NULL));

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_account_known" CHECK ("account" ~ '^(psp:[A-Z_]+|cash:manual|suspense:unmatched|clearing:order|vendor_payable|driver_payable|revenue:(service_fee|commission|delivery)|expense:(platform_discount|refund_platform|driver_cost|psp_fee|vendor_adjustment))$'),
  ADD CONSTRAINT "LedgerEntry_subject_known" CHECK (
    ("subjectType" IS NULL AND "subjectId" IS NULL)
    OR ("subjectType" IN ('ORDER', 'VENDOR', 'DRIVER') AND "subjectId" IS NOT NULL)),
  ADD CONSTRAINT "LedgerEntry_amount_nonzero" CHECK ("amountXaf" <> 0),
  ADD CONSTRAINT "LedgerEntry_currency_xaf" CHECK ("currency" = 'XAF');

-- ─── 2. Équilibre, vérifié à la fin de la transaction SQL ─────────────────

CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger AS $$
DECLARE
  tx_id TEXT;
  total BIGINT;
  n INT;
BEGIN
  IF TG_TABLE_NAME = 'LedgerTransaction' THEN
    tx_id := NEW."id";
  ELSE
    tx_id := NEW."txId";
  END IF;
  SELECT COALESCE(SUM("amountXaf"), 0), COUNT(*) INTO total, n
    FROM "LedgerEntry" WHERE "txId" = tx_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'Grand livre : la transaction % porte % ligne(s), il en faut au moins 2', tx_id, n
      USING ERRCODE = 'check_violation';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'Grand livre : la transaction % est déséquilibrée (% XAF)', tx_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LedgerEntry_balanced"
  AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- Une transaction sans aucune ligne serait invisible au trigger ci-dessus.
CREATE CONSTRAINT TRIGGER "LedgerTransaction_has_entries"
  AFTER INSERT ON "LedgerTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- ─── 3. Ajout seul ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Grand livre : % interdit sur % — corriger par contre-passation', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerTransaction_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

CREATE TRIGGER "LedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
