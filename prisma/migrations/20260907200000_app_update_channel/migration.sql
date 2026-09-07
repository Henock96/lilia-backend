-- Pilotage des mises à jour du parc mobile installé.
--
-- Les binaires publiés sur les stores ne se rappellent pas : une version qui
-- porte un défaut de paiement, ou qui parle un contrat d'API révolu, reste
-- installée jusqu'à ce que le client décide de la mettre à jour. Ces cinq
-- colonnes sont le seul levier de la plateforme sur ce parc, sans release.
--
-- Toutes nullables et sans valeur par défaut : `NULL` signifie « aucune
-- contrainte », ce qui laisse le comportement actuel strictement inchangé
-- après application de cette migration. Aucune application existante ne voit
-- de différence tant qu'un administrateur n'a rien renseigné.
ALTER TABLE "PlatformSettings"
  ADD COLUMN "minAppVersion"    TEXT,
  ADD COLUMN "latestAppVersion" TEXT,
  ADD COLUMN "updateUrlAndroid" TEXT,
  ADD COLUMN "updateUrlIos"     TEXT,
  ADD COLUMN "updateMessage"    TEXT;
