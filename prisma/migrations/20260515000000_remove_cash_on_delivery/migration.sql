-- Remove deprecated CASH_ON_DELIVERY from PaymentMethod enum
-- Safety net : migre les commandes existantes vers MTN_MOMO si jamais
-- l'enum est encore référencée (en pratique aucun usage trouvé dans le code).

UPDATE "Order" SET "paymentMethod" = 'MTN_MOMO' WHERE "paymentMethod" = 'CASH_ON_DELIVERY';

-- PostgreSQL ne permet pas de DROP une valeur d'enum directement.
-- On recrée donc l'enum en 4 étapes : rename → create new → migrate type → drop old.

ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";

CREATE TYPE "PaymentMethod" AS ENUM ('MTN_MOMO', 'AIRTEL_MONEY');

ALTER TABLE "Order"
  ALTER COLUMN "paymentMethod" TYPE "PaymentMethod"
  USING ("paymentMethod"::text::"PaymentMethod");

DROP TYPE "PaymentMethod_old";
