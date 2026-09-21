-- Unicité du téléphone utilisateur (F-12, dette ouverte depuis septembre 2026).
--
-- ## Les deux temps, et pourquoi ils sont dans la même migration
--
-- Le schéma documente un plan en trois temps : (1) écrire `NULL` et jamais `''`,
-- (2) recenser les doublons réels en lecture seule, (3) poser l'unicité une fois
-- le rapport traité. Le temps (1) est fait côté code depuis septembre ; il
-- restait les lignes HISTORIQUES, créées avec la chaîne vide.
--
-- `''` est le vrai blocage : PostgreSQL accorde à `NULL` une échappatoire à
-- l'unicité — autant de `NULL` que l'on veut — mais **pas** à la chaîne vide.
-- Deux comptes sans téléphone portaient donc « le même numéro » aux yeux d'un
-- index unique, et rendaient la contrainte impossible à créer.

UPDATE "User" SET "phone" = NULL WHERE "phone" = '';

-- ## Pourquoi l'index est GARDÉ par un bloc qui lève
--
-- On ne pose pas une contrainte qu'on n'a pas pu vérifier. Si des numéros réels
-- sont portés par plusieurs comptes, `CREATE UNIQUE INDEX` échouerait de toute
-- façon — mais sur un message PostgreSQL générique (« could not create unique
-- index … Key (phone)=(…) is duplicated »), au milieu d'un déploiement, sans
-- dire quoi faire.
--
-- Le bloc ci-dessous échoue au même endroit, en disant **quoi exécuter**. Un
-- déploiement qui s'arrête avec une consigne vaut mieux qu'un déploiement qui
-- s'arrête avec une énigme — et infiniment mieux qu'une contrainte silencieusement
-- absente, qui laisserait croire l'abus fermé alors qu'il ne l'est pas.
DO $$
DECLARE
  doublons INT;
BEGIN
  SELECT COUNT(*) INTO doublons FROM (
    SELECT "phone" FROM "User"
    WHERE "phone" IS NOT NULL
    GROUP BY "phone" HAVING COUNT(*) > 1
  ) AS d;

  IF doublons > 0 THEN
    RAISE EXCEPTION
      'Unicité du téléphone impossible : % numéro(s) porté(s) par plusieurs comptes. '
      'Exécuter `node scripts/db/audit-phone-duplicates.js` pour la liste nominative, '
      'arbitrer chaque cas (fusion, anonymisation, ou conservation délibérée), '
      'puis rejouer cette migration.', doublons;
  END IF;

  -- Index PARTIEL : `WHERE phone IS NOT NULL` est redondant avec le traitement
  -- natif des `NULL` par PostgreSQL, mais il rend l'intention lisible — et
  -- protège si la colonne devenait un jour `NOT NULL DEFAULT ''`.
  CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key"
    ON "User"("phone") WHERE "phone" IS NOT NULL;
END $$;
