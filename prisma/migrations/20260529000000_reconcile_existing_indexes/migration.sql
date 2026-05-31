-- Réconciliation drift Prisma (mai 2026, LIL-111 — Sprint A bloqué sinon)
--
-- Deux index existent en base mais n'apparaissent dans aucun fichier de migration :
--   1. Order(createdAt)  : présent dans schema.prisma (ligne ~307) mais jamais migré
--   2. payments(status)  : présent en DB mais absent du schema → ajouté ici
--      (schema.prisma : @@index([status]) ajouté sur Payment dans le même PR)
--
-- Cette migration est idempotente (CREATE INDEX IF NOT EXISTS) et peut donc
-- être appliquée sans risque sur une DB où les index existent déjà.
-- Sur une DB neuve, elle crée les deux index normalement.
--
-- Après création de ce fichier, marquer la migration comme appliquée pour les
-- environnements où les index existent déjà :
--   npx prisma migrate resolve --applied 20260529000000_reconcile_existing_indexes

CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order" ("createdAt");

CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments" ("status");
