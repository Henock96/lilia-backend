-- Destination de livraison géolocalisée (Phase 2 — 01/09/2026)
--
-- Jusqu'ici la seule coordonnée attachée à une commande était le GPS du
-- téléphone au moment du paiement. Cette migration donne à l'adresse sa
-- propre position, au quartier un centroïde de repli, et à la commande un
-- snapshot de la fiabilité de sa destination.
--
-- Entièrement ADDITIVE : aucune colonne supprimée, aucune donnée réécrite
-- autrement que pour qualifier l'existant. Une instance de l'ancien code
-- continue de fonctionner sur ce schéma.

-- ── 1. L'enum ────────────────────────────────────────────────────────────
-- `IF NOT EXISTS` sur le type : un rejeu partiel de la migration (coupure
-- réseau au milieu) doit pouvoir reprendre sans mourir sur « type already
-- exists ». Même précaution que la migration d'onboarding vendeur.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LocationPrecision') THEN
    CREATE TYPE "LocationPrecision" AS ENUM ('EXACT', 'APPROXIMATE', 'UNKNOWN');
  END IF;
END
$$;

-- ── 2. Adresses ──────────────────────────────────────────────────────────
ALTER TABLE "Adresses"
  ADD COLUMN IF NOT EXISTS "latitude"          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "locationPrecision" "LocationPrecision" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "landmark"          TEXT,
  ADD COLUMN IF NOT EXISTS "label"             TEXT;

-- Les adresses existantes n'ont aucune position : `UNKNOWN` est déjà la
-- bonne valeur et le défaut s'en charge. On ne leur invente surtout pas de
-- coordonnées — le repli sur le centroïde du quartier est calculé à la
-- commande, il n'est pas figé en base (le centroïde peut être corrigé).

-- ── 3. Quartier ──────────────────────────────────────────────────────────
ALTER TABLE "Quartier"
  ADD COLUMN IF NOT EXISTS "latitude"  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;

-- Centroïdes vérifiés le 01/09/2026 par géocodage Google, puis filtrés :
-- seuls les quartiers dont le résultat porte réellement leur nom et se
-- distingue du centre-ville générique sont posés ici.
--
-- Les 11 autres (Mpissa, Saint-Pierre, La Tsiémé, Texaco, Nkombo, Massengo,
-- Djiri, Kinsoundi, Bifouiti, Moukondo, Mfilou, Marché Total) renvoyaient
-- tous le même point — le centre de Brazzaville — parce que Google ne les
-- reconnaît pas. Les semer aurait donné 11 quartiers superposés au même
-- endroit, présentés comme des positions distinctes. Ils restent NULL et
-- seront complétés à la main via `PATCH /quartiers/:id/centroid`.
UPDATE "Quartier" SET "latitude" = -4.274440, "longitude" = 15.281280 WHERE "nom" = 'Centre-ville'       AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.285292, "longitude" = 15.263367 WHERE "nom" = 'Plateau'            AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.269500, "longitude" = 15.288366 WHERE "nom" = 'La Gare'            AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.264978, "longitude" = 15.284034 WHERE "nom" = 'Marché Poto-Poto'   AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.268916, "longitude" = 15.213630 WHERE "nom" = 'Makélékélé'         AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.295585, "longitude" = 15.245811 WHERE "nom" = 'Bacongo'            AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.274029, "longitude" = 15.267756 WHERE "nom" = 'Poto-Poto'          AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.259311, "longitude" = 15.258978 WHERE "nom" = 'Plateau des 15 ans' AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.248112, "longitude" = 15.260441 WHERE "nom" = 'Moungali'           AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.245218, "longitude" = 15.280925 WHERE "nom" = 'Ouenzé'             AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.259147, "longitude" = 15.297752 WHERE "nom" = 'Mpila'              AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.217871, "longitude" = 15.283851 WHERE "nom" = 'Talangaï'           AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.215450, "longitude" = 15.280925 WHERE "nom" = 'Mikalou'            AND "latitude" IS NULL;
UPDATE "Quartier" SET "latitude" = -4.190920, "longitude" = 15.295272 WHERE "nom" = 'Ngamakosso'         AND "latitude" IS NULL;

-- ── 4. Order ─────────────────────────────────────────────────────────────
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "deliveryPrecision" "LocationPrecision" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "deliveryLandmark"  TEXT;

-- Qualification de l'historique. Les commandes existantes qui portent des
-- coordonnées les tiennent du GPS du téléphone : ce sont de vraies
-- coordonnées, mais elles ne désignent pas l'adresse de livraison. Les
-- classer `EXACT` serait un mensonge rétroactif, et `UNKNOWN` effacerait une
-- information réellement présente. `APPROXIMATE` dit exactement ce qu'elles
-- valent — et déclenche côté livreur l'invitation à appeler le client.
UPDATE "Order"
   SET "deliveryPrecision" = 'APPROXIMATE'
 WHERE "deliveryLatitude" IS NOT NULL
   AND "deliveryLongitude" IS NOT NULL
   AND "deliveryPrecision" = 'UNKNOWN';

-- ── 5. Index ─────────────────────────────────────────────────────────────
-- Sert au tableau de bord « adresses à compléter » et à la migration future
-- des adresses existantes vers une position posée à la main.
CREATE INDEX IF NOT EXISTS "Adresses_locationPrecision_idx"
  ON "Adresses" ("locationPrecision");
