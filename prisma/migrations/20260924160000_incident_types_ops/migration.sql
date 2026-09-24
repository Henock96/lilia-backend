-- F3-04 — types d'incident ouverts par le système (cockpit ops). Seuls dans
-- leur migration : `ALTER TYPE … ADD VALUE` ne se rejoue pas dans une
-- transaction avec d'autres ordres (règle R5).
ALTER TYPE "IncidentType" ADD VALUE IF NOT EXISTS 'OPS_SLA_BREACH';
ALTER TYPE "IncidentType" ADD VALUE IF NOT EXISTS 'METRIC_ANOMALY';
