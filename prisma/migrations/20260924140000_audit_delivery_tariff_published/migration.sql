-- F3-02 — publication d'une grille de livraison, tracée au journal d'audit.
-- Seule dans sa migration : `ALTER TYPE … ADD VALUE` ne se rejoue pas dans
-- une transaction avec d'autres ordres (règle R5).
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DELIVERY_TARIFF_PUBLISHED';
