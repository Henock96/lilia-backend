-- Suppression de l'enum mort `OrderLifecycleStatus` et de la colonne
-- `Order.lifecycleStatus` (jamais lue ni écrite — B12 de l'audit 2026-06-02).

-- DropIndex
DROP INDEX IF EXISTS "Order_lifecycleStatus_idx";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN IF EXISTS "lifecycleStatus";

-- DropEnum
DROP TYPE IF EXISTS "OrderLifecycleStatus";
