-- Add Incident tracking — supports manual incidents (rider accidents, customer complaints)
-- and auto-generated incidents from order.cancelled events.

CREATE TYPE "IncidentType" AS ENUM (
  'ORDER_CANCELLED',
  'ORDER_DELAYED',
  'PAYMENT_FAILED',
  'DRIVER_NO_SHOW',
  'DRIVER_ACCIDENT',
  'CUSTOMER_COMPLAINT',
  'RESTAURANT_CLOSED',
  'STOCK_ISSUE',
  'WRONG_DELIVERY',
  'REFUND_REQUEST',
  'OTHER'
);

CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

CREATE TABLE "Incident" (
  "id"           TEXT NOT NULL,
  "type"         "IncidentType" NOT NULL,
  "severity"     "IncidentSeverity" NOT NULL DEFAULT 'MEDIUM',
  "status"       "IncidentStatus" NOT NULL DEFAULT 'OPEN',
  "title"        TEXT NOT NULL,
  "description"  TEXT NOT NULL,
  "resolution"   TEXT,
  "orderId"      TEXT,
  "riderId"      TEXT,
  "restaurantId" TEXT,
  "reportedBy"   TEXT,
  "resolvedBy"   TEXT,
  "metadata"     JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "resolvedAt"   TIMESTAMP(3),
  CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Incident_status_severity_idx" ON "Incident"("status", "severity");
CREATE INDEX "Incident_type_createdAt_idx"  ON "Incident"("type", "createdAt");
CREATE INDEX "Incident_orderId_idx"          ON "Incident"("orderId");
CREATE INDEX "Incident_riderId_idx"          ON "Incident"("riderId");
CREATE INDEX "Incident_restaurantId_idx"     ON "Incident"("restaurantId");
