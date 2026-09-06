-- Un quartier, un seul tarif de livraison par vendeur (6 septembre 2026)
--
-- FIX L-6 — audit du 05/09/2026.
--
-- `QuartierZone` ne portait que `@@unique([quartierId, deliveryZoneId])` : le
-- doublon était interdit dans UNE zone, pas l'appartenance à DEUX zones du
-- même vendeur. Or `QuartiersService.calculateDeliveryFee` retourne la
-- **première** zone trouvée en parcourant un `include` sans `orderBy` —
-- l'ordre des lignes n'est pas garanti par PostgreSQL. Deux clients du même
-- quartier pouvaient donc payer deux tarifs différents, sans que rien ne le
-- signale.
--
-- La correction porte la règle en base plutôt que dans un `if` : il y a trois
-- chemins d'écriture (création de zone, mise à jour, ajout de quartiers), plus
-- les scripts d'administration, et un `if` ne protège que celui qu'il traverse.
--
-- ⚠️ ÉTAT DE LA PRODUCTION AU 06/09/2026 — vérifié avant écriture de cette
-- migration : **zéro chevauchement**. Un seul vendeur utilise les zones
-- (« Chez Maman Lili », 6 quartiers répartis sur 3 zones, tous distincts) ;
-- les trois autres n'ont aucune zone. L'étape 3 est donc un no-op en
-- production — elle existe pour les bases de développement et pour le cas où
-- un chevauchement serait créé avant que cette migration ne s'applique.
--
-- Aucune zone n'est supprimée. Aucun tarif n'est modifié.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Colonne dénormalisée `restaurantId`
--
--    Nullable d'abord : la contrainte NOT NULL ne peut venir qu'après le
--    remplissage, sinon la migration échoue sur la première ligne existante.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "QuartierZone" ADD COLUMN IF NOT EXISTS "restaurantId" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Remplissage depuis la zone
--
--    `restaurantId` n'est jamais saisi : il est recopié depuis la zone, et la
--    clé étrangère composite de l'étape 5 garantit ensuite qu'il ne peut pas
--    en diverger.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE "QuartierZone" qz
   SET "restaurantId" = dz."restaurantId"
  FROM "DeliveryZone" dz
 WHERE dz.id = qz."deliveryZoneId"
   AND qz."restaurantId" IS DISTINCT FROM dz."restaurantId";

-- Filet : un rattachement sans zone n'a aucun sens et bloquerait le NOT NULL.
-- La clé étrangère en CASCADE, active depuis août 2026, rend ce cas impossible
-- en pratique — on le traite quand même plutôt que de faire échouer la
-- migration sur une base ancienne.
DELETE FROM "QuartierZone" WHERE "restaurantId" IS NULL;

ALTER TABLE "QuartierZone" ALTER COLUMN "restaurantId" SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Déduplication — on garde le TARIF LE PLUS BAS
--
--    Un chevauchement signifie que deux tarifs sont déclarés pour un même
--    quartier. Il faut trancher pour poser la contrainte, et le choix n'est
--    pas neutre : il change un prix.
--
--    On garde le moins cher, pour deux raisons. D'abord, l'arbitrage actuel
--    n'est PAS « le premier déclaré » mais « celui que PostgreSQL renvoie en
--    premier », c'est-à-dire indéterminé : on ne détruit donc aucune règle
--    existante, on remplace de l'aléatoire par du déterministe. Ensuite, entre
--    deux prix qu'un vendeur a lui-même déclarés, celui qui ne peut pas léser
--    le client est le plus bas.
--
--    `ctid` départage les ex æquo parfaits (même tarif) : il faut un critère
--    total, sinon la requête est elle-même non déterministe.
-- ─────────────────────────────────────────────────────────────────────────────

DELETE FROM "QuartierZone" qz
 USING (
   SELECT qz2.ctid AS doomed
     FROM "QuartierZone" qz2
     JOIN "DeliveryZone" dz2 ON dz2.id = qz2."deliveryZoneId"
    WHERE EXISTS (
      SELECT 1
        FROM "QuartierZone" keep
        JOIN "DeliveryZone" kdz ON kdz.id = keep."deliveryZoneId"
       WHERE keep."restaurantId" = qz2."restaurantId"
         AND keep."quartierId"   = qz2."quartierId"
         AND (kdz.fee, keep.ctid) < (dz2.fee, qz2.ctid)
    )
 ) losers
 WHERE qz.ctid = losers.doomed;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Unicité : un quartier, un seul tarif par vendeur
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "QuartierZone_restaurantId_quartierId_key"
  ON "QuartierZone" ("restaurantId", "quartierId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Clé étrangère composite — c'est elle qui rend l'étape 4 fiable
--
--    Sans elle, `restaurantId` serait une simple copie qui pourrait diverger de
--    la zone (une écriture hors service, un script), et l'unicité porterait
--    alors sur une donnée fausse. Avec elle, PostgreSQL refuse tout
--    rattachement dont le `restaurantId` n'est pas celui de sa zone.
--
--    Même idiome que `Product → Category` sur `(categoryId, restaurantId)`.
--    L'ancienne FK simple est remplacée : garder les deux ferait deux
--    contraintes pour une seule règle.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryZone_id_restaurantId_key"
  ON "DeliveryZone" ("id", "restaurantId");

ALTER TABLE "QuartierZone"
  DROP CONSTRAINT IF EXISTS "QuartierZone_deliveryZoneId_fkey";

ALTER TABLE "QuartierZone"
  ADD CONSTRAINT "QuartierZone_deliveryZoneId_restaurantId_fkey"
  FOREIGN KEY ("deliveryZoneId", "restaurantId")
  REFERENCES "DeliveryZone" ("id", "restaurantId")
  ON DELETE CASCADE ON UPDATE CASCADE;
