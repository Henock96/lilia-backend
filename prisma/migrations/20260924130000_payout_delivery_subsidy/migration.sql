-- F3-02 — la part de la livraison offerte par le vendeur est retenue sur son
-- reversement, et figée sur la pièce comptable. Additive : `0` pour tous les
-- reversements existants, ce qui est exact (aucune subvention n'existait).
ALTER TABLE "restaurant_payouts"
  ADD COLUMN "deliverySubsidyAmount" INTEGER NOT NULL DEFAULT 0;

-- Même esprit que `restaurant_payouts_amounts_valid` (20260923130000).
-- Table neuve pour cette colonne : aucune ligne ne peut la violer, la
-- contrainte est donc validée immédiatement.
ALTER TABLE "restaurant_payouts" ADD CONSTRAINT "restaurant_payouts_delivery_subsidy_non_negative"
  CHECK ("deliverySubsidyAmount" >= 0);
