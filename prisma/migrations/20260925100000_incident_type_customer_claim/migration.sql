-- F3-06 — réclamation client.
--
-- Ajouts de valeurs d'enum seuls dans leur migration (R5) : une valeur ajoutée par `ALTER TYPE … ADD
-- VALUE` n'est utilisable qu'après le commit de la transaction qui l'a créée.
ALTER TYPE "IncidentType" ADD VALUE IF NOT EXISTS 'CUSTOMER_CLAIM';

-- Gestes d'administration propres aux réclamations (journal d'audit).
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CLAIM_VOUCHER_ISSUED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CLAIM_REJECTED';
