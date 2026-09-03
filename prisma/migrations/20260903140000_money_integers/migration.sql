-- ═══════════════════════════════════════════════════════════════════════════
-- Dette M12 — les montants en francs CFA deviennent des ENTIERS
--
-- Le XAF n'a pas de sous-unité : « 1 250,5 FCFA » ne veut rien dire. Les DTO
-- imposaient déjà `@IsInt` (fix B-6) et l'arithmétique passe par
-- `money.util.ts` en points de base ; la colonne restait le dernier endroit où
-- une décimale était représentable — donc où une écriture hors service, une
-- migration manuelle ou un import pouvait en introduire une.
--
-- Vérifié AVANT écriture sur la base de production
-- (`scripts/db/audit-decimal-amounts.js`, lecture seule) : sur les 18 colonnes
-- converties, **zéro valeur décimale** parmi 113 commandes, 216 lignes de
-- commande, 46 paiements et 7 usages de promo. Le `round()` ci-dessous est
-- donc un no-op sur l'existant ; il est écrit pour le cas où il ne le serait
-- pas, et pour que la migration reste rejouable sur n'importe quelle base.
--
-- ⚠️ CE QUI RESTE DÉLIBÉRÉMENT EN `double precision` :
--   · les POURCENTAGES — `Order.commissionPercent`,
--     `restaurant_payouts.commissionPercent`, `Restaurant.commissionPercent`,
--     `PlatformSettings.serviceFeePercent` / `restaurantCommissionPercent`.
--     Une proportion n'est pas un montant : 8,5 % est légitime.
--   · `PromoCode.discountValue` — porte un montant XAF si `discountType`
--     vaut FIXED, un POURCENTAGE s'il vaut PERCENT. La convertir interdirait
--     silencieusement une campagne à 7,5 %. L'intégrité du cas FIXED est tenue
--     par le DTO (`PromoDiscountValueConstraint`), là où le discriminant est
--     connu.
--   · les coordonnées, la précision GPS et `Product.alcoholContent`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Order ─────────────────────────────────────────────────────────────────
ALTER TABLE "Order" ALTER COLUMN "subTotal"    TYPE INTEGER USING round("subTotal")::int;
ALTER TABLE "Order" ALTER COLUMN "deliveryFee" TYPE INTEGER USING round("deliveryFee")::int;
ALTER TABLE "Order" ALTER COLUMN "total"       TYPE INTEGER USING round("total")::int;

ALTER TABLE "Order" ALTER COLUMN "serviceFee" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "serviceFee" TYPE INTEGER USING round("serviceFee")::int;
ALTER TABLE "Order" ALTER COLUMN "serviceFee" SET DEFAULT 0;

ALTER TABLE "Order" ALTER COLUMN "discountAmount" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "discountAmount" TYPE INTEGER USING round("discountAmount")::int;
ALTER TABLE "Order" ALTER COLUMN "discountAmount" SET DEFAULT 0;

ALTER TABLE "Order" ALTER COLUMN "commissionAmount" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "commissionAmount" TYPE INTEGER USING round("commissionAmount")::int;
ALTER TABLE "Order" ALTER COLUMN "commissionAmount" SET DEFAULT 0;

-- ─── OrderItem ─────────────────────────────────────────────────────────────
ALTER TABLE "OrderItem" ALTER COLUMN "prix"          TYPE INTEGER USING round("prix")::int;
ALTER TABLE "OrderItem" ALTER COLUMN "snapshotPrice" TYPE INTEGER USING round("snapshotPrice")::int;

-- ─── Payment ───────────────────────────────────────────────────────────────
ALTER TABLE "payments" ALTER COLUMN "amount"           TYPE INTEGER USING round("amount")::int;
ALTER TABLE "payments" ALTER COLUMN "collectionFeeXaf" TYPE INTEGER USING round("collectionFeeXaf")::int;

-- ─── RestaurantPayout ──────────────────────────────────────────────────────
ALTER TABLE "restaurant_payouts" ALTER COLUMN "grossAmount"      TYPE INTEGER USING round("grossAmount")::int;
ALTER TABLE "restaurant_payouts" ALTER COLUMN "commissionAmount" TYPE INTEGER USING round("commissionAmount")::int;
ALTER TABLE "restaurant_payouts" ALTER COLUMN "amount"           TYPE INTEGER USING round("amount")::int;
ALTER TABLE "restaurant_payouts" ALTER COLUMN "payoutFeeXaf"     TYPE INTEGER USING round("payoutFeeXaf")::int;

-- ─── Refund ────────────────────────────────────────────────────────────────
ALTER TABLE "Refund" ALTER COLUMN "amount" TYPE INTEGER USING round("amount")::int;

-- ─── PromoCode ─────────────────────────────────────────────────────────────
ALTER TABLE "PromoCode" ALTER COLUMN "maxDiscount" TYPE INTEGER USING round("maxDiscount")::int;

ALTER TABLE "PromoCode" ALTER COLUMN "minOrderAmount" DROP DEFAULT;
ALTER TABLE "PromoCode" ALTER COLUMN "minOrderAmount" TYPE INTEGER USING round("minOrderAmount")::int;
ALTER TABLE "PromoCode" ALTER COLUMN "minOrderAmount" SET DEFAULT 0;

-- Colonne MORTE, supprimée. Dupliquée depuis `Order.discountAmount`, elle n'a
-- jamais été ni lue ni écrite depuis sa création : toutes les lignes portent le
-- défaut 0 (vérifié en production). Une colonne qui ressemble à un montant sans
-- en être un finit par être lue de bonne foi.
ALTER TABLE "PromoCode" DROP COLUMN IF EXISTS "discountAmount";

-- ─── PromoUsage ────────────────────────────────────────────────────────────
ALTER TABLE "PromoUsage" ALTER COLUMN "discountApplied" TYPE INTEGER USING round("discountApplied")::int;
