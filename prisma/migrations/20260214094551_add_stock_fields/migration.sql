-- AlterTable
ALTER TABLE "MenuDuJour" ADD COLUMN     "stockQuotidien" INTEGER,
ADD COLUMN     "stockRestant" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "stockQuotidien" INTEGER,
ADD COLUMN     "stockRestant" INTEGER;
