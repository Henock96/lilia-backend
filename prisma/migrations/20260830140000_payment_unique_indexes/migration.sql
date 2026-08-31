-- Unicité des paiements : porter en base ce que le code tenait en mémoire.
--
-- `PaymentService.assertNoPendingPayment` et le `findFirst`-puis-`create` de
-- `createManualPayment` sont des **read-then-write** : deux requêtes concurrentes
-- (double-tap, retry du RetryInterceptor client, deux onglets) lisent toutes
-- deux « aucun paiement en attente » et créent chacune leur ligne.
--
-- En mode MANUAL, deux `Payment` PENDING sur une commande n'étaient qu'un
-- désagrément pour l'administrateur. Avec un prestataire qui débite réellement,
-- ce sont **deux `POST /v2/deposits`, donc deux débits du client** — un incident
-- non rattrapable sans remboursement.
--
-- Deux index UNIQUES PARTIELS ferment la fenêtre. Prisma ne sait pas les
-- déclarer (pas de `WHERE` dans `@@unique`), d'où ce fichier SQL.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Nettoyage préalable — sans quoi la création de l'index échoue en production
-- ─────────────────────────────────────────────────────────────────────────────
--
-- On ne supprime rien : les paiements surnuméraires passent CANCELLED. Une ligne
-- `Payment` est une pièce comptable, même quand elle n'a jamais abouti — et si
-- de l'argent a réellement été envoyé sur l'un d'eux, la trace doit subsister
-- pour la procédure de remboursement.
--
-- Le PENDING conservé par commande est le **plus récent** : c'est celui dont les
-- instructions ont été affichées au client en dernier, donc celui sur lequel il
-- a le plus probablement payé.
UPDATE "payments" p
SET "status"    = 'CANCELLED',
    "updatedAt" = NOW(),
    "metadata"  = COALESCE(p."metadata", '{}'::jsonb)
                  || jsonb_build_object(
                       'cancelledBy', 'migration:payment_unique_indexes',
                       'cancelReason', 'Doublon PENDING sur la meme commande'
                     )
WHERE p."status" = 'PENDING'
  AND p."id" <> (
    SELECT keep."id"
    FROM "payments" keep
    WHERE keep."orderId" = p."orderId"
      AND keep."status" = 'PENDING'
    ORDER BY keep."createdAt" DESC, keep."id" DESC
    LIMIT 1
  );

-- Même traitement pour les références prestataire dupliquées. Ce cas ne devrait
-- pas exister (la référence est un UUID généré par nous), mais l'index refuserait
-- de se créer et bloquerait le déploiement : on préfère le constater ici.
UPDATE "payments" p
SET "status"    = 'CANCELLED',
    "updatedAt" = NOW(),
    "metadata"  = COALESCE(p."metadata", '{}'::jsonb)
                  || jsonb_build_object(
                       'cancelledBy', 'migration:payment_unique_indexes',
                       'cancelReason', 'Reference prestataire dupliquee'
                     )
WHERE p."providerTransactionId" IS NOT NULL
  AND p."id" <> (
    SELECT keep."id"
    FROM "payments" keep
    WHERE keep."provider" = p."provider"
      AND keep."providerTransactionId" = p."providerTransactionId"
    ORDER BY
      -- On garde en priorité celui qui a abouti : un SUCCESS porte de l'argent.
      CASE keep."status" WHEN 'SUCCESS' THEN 0 ELSE 1 END,
      keep."createdAt" DESC,
      keep."id" DESC
    LIMIT 1
  );

-- La déduplication ci-dessus laisserait deux SUCCESS partageant une référence
-- (cas théorique) sans les distinguer. On neutralise alors la référence du plus
-- ancien plutôt que d'annuler un encaissement réel.
UPDATE "payments" p
SET "providerTransactionId" = NULL,
    "updatedAt"             = NOW(),
    "metadata"              = COALESCE(p."metadata", '{}'::jsonb)
                              || jsonb_build_object(
                                   'detachedProviderTransactionId', p."providerTransactionId",
                                   'detachedBy', 'migration:payment_unique_indexes'
                                 )
WHERE p."providerTransactionId" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "payments" other
    WHERE other."provider" = p."provider"
      AND other."providerTransactionId" = p."providerTransactionId"
      AND other."id" <> p."id"
  )
  AND p."id" <> (
    SELECT keep."id"
    FROM "payments" keep
    WHERE keep."provider" = p."provider"
      AND keep."providerTransactionId" = p."providerTransactionId"
    ORDER BY keep."createdAt" DESC, keep."id" DESC
    LIMIT 1
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Les contraintes
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Pas de `CONCURRENTLY` : Prisma exécute chaque migration dans une transaction,
-- et `CREATE INDEX CONCURRENTLY` y est interdit par PostgreSQL. La table
-- `payments` compte quelques milliers de lignes au lancement — le verrou dure
-- quelques millisecondes. Si elle devenait volumineuse, l'index se recréerait
-- hors migration, en `CONCURRENTLY`, avant de rejouer ce fichier.

-- UNE commande = AU PLUS UNE tentative de paiement active.
-- `WHERE status = 'PENDING'` : les paiements résolus (SUCCESS/FAILED/CANCELLED)
-- ne sont pas contraints, ce qui autorise plusieurs tentatives successives.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_order_pending_uq"
  ON "payments" ("orderId")
  WHERE "status" = 'PENDING';

-- UNE référence prestataire = UNE ligne. Rend la recherche du webhook
-- déterministe : `findUnique` par référence ne peut pas ramener deux paiements.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_provider_tx_uq"
  ON "payments" ("provider", "providerTransactionId")
  WHERE "providerTransactionId" IS NOT NULL;
