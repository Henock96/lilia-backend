-- F3-08 — valeurs d'audit, SEULES dans leur migration : `ALTER TYPE … ADD
-- VALUE` ne peut pas être suivi, dans la même transaction, d'une écriture qui
-- utilise la valeur (précédent : 20260830120000_vendor_onboarding).
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'APPROVAL_REQUESTED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'APPROVAL_DECIDED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CAPABILITY_CHANGED';
