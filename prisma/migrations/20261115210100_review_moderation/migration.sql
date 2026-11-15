-- Lot B (15/11/2026) — avis : modération (masquer plutôt que supprimer) et
-- réponse publique du vendeur.
--
-- ADDITIVE : colonnes NULL sur "Review" et "DeliveryReview", et deux CHECK que
-- toutes les lignes existantes satisfont (colonnes NULL). Aucune ligne
-- réécrite, aucun backfill. Le code précédent ignore ces colonnes.
--
-- Impact production : `ADD COLUMN` sans défaut = catalogue seul ; chaque
-- `ADD CONSTRAINT … CHECK` parcourt sa table sous ACCESS EXCLUSIVE (quelques
-- centaines de lignes au plus, de l'ordre de la milliseconde).
--
-- Rollback : revenir au code précédent suffit. Si besoin, après retour du code :
--   ALTER TABLE "DeliveryReview" DROP CONSTRAINT "DeliveryReview_hidden_consistent";
--   ALTER TABLE "DeliveryReview" DROP COLUMN "hiddenReason", DROP COLUMN "hiddenById", DROP COLUMN "hiddenAt";
--   ALTER TABLE "Review" DROP CONSTRAINT "Review_moderation_consistent";
--   ALTER TABLE "Review" DROP COLUMN "vendorReplyHiddenAt", DROP COLUMN "vendorReplyAt",
--     DROP COLUMN "vendorReply", DROP COLUMN "hiddenReason", DROP COLUMN "hiddenById", DROP COLUMN "hiddenAt";
-- (les avis masqués redeviendraient alors visibles, et les réponses seraient perdues).

SET lock_timeout = '5s';

ALTER TABLE "Review" ADD COLUMN "hiddenAt" TIMESTAMP(3),
ADD COLUMN "hiddenById" TEXT,
ADD COLUMN "hiddenReason" TEXT,
ADD COLUMN "vendorReply" TEXT,
ADD COLUMN "vendorReplyAt" TIMESTAMP(3),
ADD COLUMN "vendorReplyHiddenAt" TIMESTAMP(3);

-- Un masquage porte toujours son motif ; une réponse masquée existe ; une
-- réponse porte sa date. La longueur (1 000) est une règle de DTO.
ALTER TABLE "Review" ADD CONSTRAINT "Review_moderation_consistent" CHECK (
  ("hiddenAt" IS NULL) = ("hiddenReason" IS NULL)
  AND ("vendorReply" IS NULL) = ("vendorReplyAt" IS NULL)
  AND ("vendorReplyHiddenAt" IS NULL OR "vendorReply" IS NOT NULL)
);

ALTER TABLE "DeliveryReview" ADD COLUMN "hiddenAt" TIMESTAMP(3),
ADD COLUMN "hiddenById" TEXT,
ADD COLUMN "hiddenReason" TEXT;

ALTER TABLE "DeliveryReview" ADD CONSTRAINT "DeliveryReview_hidden_consistent" CHECK (
  ("hiddenAt" IS NULL) = ("hiddenReason" IS NULL)
);
