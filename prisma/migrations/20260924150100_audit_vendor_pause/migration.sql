-- F3-03 — pause forcée d'un vendeur par l'admin et changements du calendrier
-- des jours fériés, tracés au journal d'audit. Seules dans leur migration :
-- `ALTER TYPE … ADD VALUE` ne se rejoue pas dans une transaction avec
-- d'autres ordres (règle R5).
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VENDOR_PAUSED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PUBLIC_HOLIDAY_UPDATED';
