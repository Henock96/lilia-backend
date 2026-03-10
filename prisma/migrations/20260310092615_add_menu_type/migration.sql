-- CreateEnum
CREATE TYPE "MenuType" AS ENUM ('COMBO', 'PLAT_SPECIAL');

-- AlterTable
ALTER TABLE "MenuDuJour" ADD COLUMN     "ingredients" TEXT,
ADD COLUMN     "type" "MenuType" NOT NULL DEFAULT 'COMBO';
