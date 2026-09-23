-- Contraintes d'intégrité sur l'argent et le stock (Master Audit v1, D-3).
--
-- Jusqu'ici, « un montant n'est jamais négatif » et « un stock ne descend
-- jamais sous zéro » n'étaient garantis que par le code applicatif. Une
-- écriture hors service (script, correction SQL, régression) pouvait les
-- violer sans que rien ne le signale.
--
-- ⚠️ `NOT VALID` : PostgreSQL applique la contrainte à toute écriture FUTURE
-- (INSERT et UPDATE de la ligne) mais ne scanne pas l'existant. Donc :
--   - aucun verrou long sur les grosses tables au déploiement ;
--   - aucun échec de migration si une donnée historique est hors bornes.
-- Une fois l'existant contrôlé, les valider une à une hors déploiement :
--   ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_amounts_non_negative";
-- (lecture seule sur les lignes, verrou SHARE UPDATE EXCLUSIVE — compatible
-- avec les écritures).
--
-- Prisma ne modélise pas les CHECK : ils n'apparaissent pas dans le schéma et
-- ne créent aucune dérive pour `migrate diff`.
--
-- Rollback : `ALTER TABLE … DROP CONSTRAINT …` pour chacune — aucune donnée
-- n'est modifiée par cette migration.

ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_non_negative" CHECK (
  "subTotal" >= 0 AND "deliveryFee" >= 0 AND "deliveryFeeGross" >= 0
  AND "serviceFee" >= 0 AND "total" >= 0 AND "discountAmount" >= 0
  AND "commissionAmount" >= 0 AND "loyaltyPointsUsed" >= 0
  AND "loyaltyDiscount" >= 0
) NOT VALID;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_quantity_price_valid"
  CHECK ("quantite" > 0 AND "prix" >= 0) NOT VALID;

ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_quantity_positive"
  CHECK ("quantite" > 0) NOT VALID;

ALTER TABLE "Product" ADD CONSTRAINT "Product_price_stock_non_negative"
  CHECK ("prixOriginal" >= 0 AND ("stockRestant" IS NULL OR "stockRestant" >= 0)) NOT VALID;

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_price_non_negative"
  CHECK ("prix" >= 0) NOT VALID;

ALTER TABLE "MenuDuJour" ADD CONSTRAINT "MenuDuJour_price_stock_non_negative"
  CHECK ("prix" >= 0 AND ("stockRestant" IS NULL OR "stockRestant" >= 0)) NOT VALID;

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_non_negative"
  CHECK ("amount" >= 0) NOT VALID;

ALTER TABLE "restaurant_payouts" ADD CONSTRAINT "restaurant_payouts_amounts_valid"
  CHECK ("amount" > 0 AND "grossAmount" >= 0 AND "commissionAmount" >= 0) NOT VALID;

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_positive"
  CHECK ("amount" > 0) NOT VALID;

ALTER TABLE "User" ADD CONSTRAINT "User_loyalty_points_non_negative"
  CHECK ("loyaltyPoints" >= 0) NOT VALID;

ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_amount_non_negative"
  CHECK ("amountXaf" >= 0) NOT VALID;

ALTER TABLE "DeliveryHandover" ADD CONSTRAINT "DeliveryHandover_attempts_non_negative"
  CHECK ("attempts" >= 0) NOT VALID;
