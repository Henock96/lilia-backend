/**
 * Premium (Lot 2) — vocabulaires de `VendorSubscription`.
 *
 * Miroirs exacts des CHECK de la migration `20261011150100_vendor_subscriptions`
 * (règle 14 : TEXT + CHECK + liste TypeScript, pas d'enum PostgreSQL). Ajouter
 * une valeur ici sans migration fait échouer l'insertion en base — c'est voulu.
 */
export const SUBSCRIPTION_PLANS = ['PREMIUM'] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Moyen par lequel le vendeur a payé, hors plateforme. */
export const SUBSCRIPTION_PAYMENT_METHODS = [
  'MOBILE_MONEY',
  'CASH',
  'BANK_TRANSFER',
  'OTHER',
] as const;
export type SubscriptionPaymentMethod =
  (typeof SUBSCRIPTION_PAYMENT_METHODS)[number];

/**
 * Premium S1 — moyen d'une période **payée par le vendeur dans la
 * plateforme** (dépôt pawaPay). Jamais saisi par un administrateur : absent de
 * `SUBSCRIPTION_PAYMENT_METHODS`, que le DTO d'attribution accepte. Miroir du
 * CHECK `VendorSubscription_paymentMethod_check`
 * (migration `20261125120000_premium_subscription_payments`).
 */
export const IN_PLATFORM_PAYMENT_METHOD = 'PAWAPAY' as const;

/** Durées proposées à l'achat (CHECK `SubscriptionPayment_months_check`). */
export const SUBSCRIPTION_DURATIONS_MONTHS = [1, 3, 6, 12] as const;
export type SubscriptionDurationMonths =
  (typeof SUBSCRIPTION_DURATIONS_MONTHS)[number];

/** CHECK `SubscriptionPayment_status_check`. */
export const SUBSCRIPTION_PAYMENT_STATUSES = [
  'PENDING',
  'SUCCESS',
  'FAILED',
] as const;
export type SubscriptionPaymentStatus =
  (typeof SUBSCRIPTION_PAYMENT_STATUSES)[number];

/**
 * Droits accordés par chaque formule. Noms de travail du Lot 0.
 * `ON_SITE_RESERVATIONS` est consommé par le Lot 3 (configuration des
 * réservations) et le Lot 4 (parcours client) — numérotation redéfinie par le
 * propriétaire produit les 12 et 17/10/2026 ; `ANALYTICS_ADVANCED` attend un
 * lot de statistiques à replanifier. Rien en base : ajouter un droit à une
 * formule ne demande aucune migration.
 */
export const PLAN_ENTITLEMENTS = {
  PREMIUM: ['ANALYTICS_ADVANCED', 'ON_SITE_RESERVATIONS'],
} as const satisfies Record<SubscriptionPlan, readonly string[]>;

export type Entitlement = (typeof PLAN_ENTITLEMENTS)[SubscriptionPlan][number];
