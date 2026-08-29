-- Journal d'audit des actions d'administration (audit du 28/08/2026).
--
-- `updateUserRole`, `banUser`, `suspendVendor` et `confirmManualPayment`
-- changent des droits ou décident qu'une commande est payée. Ils ne laissaient
-- qu'une ligne de log applicatif : perdue à la rotation, non interrogeable et
-- sans valeur en cas de litige. La table est en écriture seule côté
-- application — aucun endpoint ne la modifie ni ne la supprime.

CREATE TYPE "AdminAuditAction" AS ENUM (
  'USER_ROLE_CHANGED',
  'USER_BANNED',
  'USER_UNBANNED',
  'VENDOR_APPROVED',
  'VENDOR_SUSPENDED',
  'VENDOR_ACTIVE_TOGGLED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_REJECTED',
  'REFUND_CREATED',
  'REFUND_UPDATED',
  'ORDER_STATUS_FORCED'
);

CREATE TABLE "AdminAuditLog" (
  "id"         TEXT NOT NULL,
  "actorId"    TEXT NOT NULL,
  "action"     "AdminAuditAction" NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId"   TEXT NOT NULL,
  "reason"     TEXT,
  "metadata"   JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditLog_actorId_createdAt_idx"
  ON "AdminAuditLog"("actorId", "createdAt" DESC);
CREATE INDEX "AdminAuditLog_targetType_targetId_idx"
  ON "AdminAuditLog"("targetType", "targetId");
CREATE INDEX "AdminAuditLog_action_createdAt_idx"
  ON "AdminAuditLog"("action", "createdAt" DESC);

-- RESTRICT : un compte qui a exercé des pouvoirs d'admin ne doit pas pouvoir
-- disparaître du journal. La suppression de compte (DELETE /users/me) anonymise
-- la ligne User au lieu de la supprimer, la contrainte tient donc.
ALTER TABLE "AdminAuditLog"
  ADD CONSTRAINT "AdminAuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
