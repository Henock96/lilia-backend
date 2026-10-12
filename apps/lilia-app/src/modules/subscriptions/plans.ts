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
 * Droits accordés par chaque formule. Noms de travail du Lot 0, consommés à
 * partir du Lot 3 (statistiques) et du Lot 5 (réservations). Rien en base :
 * ajouter un droit à une formule ne demande aucune migration.
 */
export const PLAN_ENTITLEMENTS = {
  PREMIUM: ['ANALYTICS_ADVANCED', 'ON_SITE_RESERVATIONS'],
} as const satisfies Record<SubscriptionPlan, readonly string[]>;

export type Entitlement = (typeof PLAN_ENTITLEMENTS)[SubscriptionPlan][number];
