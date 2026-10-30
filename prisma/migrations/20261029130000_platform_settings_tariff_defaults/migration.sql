-- Politique tarifaire du 29/10/2026 : frais de service client 15 %,
-- commission vendeur 0 % (choix de lancement).
--
-- ⚠️ Ne change QUE la valeur par défaut des colonnes, c'est-à-dire ce que
-- reçoit une ligne `PlatformSettings` CRÉÉE après cette migration (base
-- vierge, préproduction neuve, `upsert` de premier démarrage).
--
-- La ligne `singleton` déjà enregistrée en production n'est PAS modifiée :
-- aucun `UPDATE` ici, délibérément. Si sa valeur contredit la politique, la
-- corriger par le réglage administrateur (journalisé), pas par une migration
-- qui écraserait une décision sans trace.
--
-- Les commandes existantes gardent leurs snapshots (`Order.serviceFee`,
-- `Order.commissionPercent`) : rien n'est recalculé.
--
-- Rollback : remettre les anciens défauts (8 et 10) par la même instruction.

ALTER TABLE "PlatformSettings" ALTER COLUMN "serviceFeePercent" SET DEFAULT 15;
ALTER TABLE "PlatformSettings" ALTER COLUMN "restaurantCommissionPercent" SET DEFAULT 0;
