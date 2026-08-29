-- Boîte d'envoi transactionnelle (fix H7, audit du 28/08/2026).
--
-- Le seul signal prévenant un vendeur qu'une commande est arrivée était un push
-- FCM émis via EventEmitter2 EN MÉMOIRE, après le commit : process tué entre les
-- deux ⇒ événement perdu sans trace ; erreur de listener ⇒ avalée
-- (`suppressErrors ?? true`) ; vendeur sans token FCM ⇒ simple warn. Une
-- commande payée pouvait n'être jamais vue — le risque opérationnel n°1 pour
-- une marketplace de restauration.
--
-- La ligne est désormais écrite DANS la transaction de checkout : si la commande
-- existe, l'obligation de notifier existe. `OutboxDispatcherService` la dépile
-- toutes les 30 s avec backoff exponentiel, et escalade en SMS Infobip si la
-- commande n'est pas prise en charge au bout de 10 minutes.

CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "OutboxEvent" (
  "id"            TEXT NOT NULL,
  "type"          TEXT NOT NULL,
  "aggregateId"   TEXT NOT NULL,
  "payload"       JSONB NOT NULL,
  "status"        "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError"     TEXT,
  "escalatedAt"   TIMESTAMP(3),
  "processedAt"   TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- Requête du worker : les PENDING dus, les plus anciens d'abord.
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx"
  ON "OutboxEvent"("status", "nextAttemptAt");
CREATE INDEX "OutboxEvent_aggregateId_type_idx"
  ON "OutboxEvent"("aggregateId", "type");
