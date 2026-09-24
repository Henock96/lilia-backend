-- F3-05 — conclusion d'un échec de livraison, tracée au journal d'audit.
-- Seule dans sa migration : `ALTER TYPE … ADD VALUE` (règle R5).
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ORDER_FAILURE_CONCLUDED';
