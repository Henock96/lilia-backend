import { ConflictException } from '@nestjs/common';
import { DeliveryPricingMode, PlatformSettings, Prisma } from '@prisma/client';

/**
 * R-09 — réglages de plateforme qui fixent de l'argent.
 *
 * Ils fixent ce que paient les clients (frais de service, tarification de la
 * course), ce que touchent les vendeurs (commission, versements automatiques)
 * ou le passif de fidélité (valeur et volume des points). La règle 9 de la
 * constitution en fait des gestes financiers : `FINANCE_EXECUTE`, un second
 * administrateur, MFA. Ils ne passent donc plus par
 * `PATCH /admin/platform-settings` (capacité `SETTINGS`), mais par une demande
 * approuvée (`ApprovalKind.PLATFORM_SETTINGS_CHANGE`).
 *
 * Toute colonne nouvelle de `PlatformSettings` qui touche l'argent s'ajoute ici.
 */
export const FINANCIAL_SETTING_KEYS = [
  'serviceFeePercent',
  'groceryServiceFeeBps',
  'restaurantCommissionPercent',
  'loyaltyPointValueXaf',
  'loyaltyPointsPerOrder',
  'loyaltyMinRedemption',
  'referrerBonusPoints',
  'vendorPayoutAutoEnabled',
  'vendorPayoutDelayMinutes',
  'deliveryPricingMode',
] as const;

export type FinancialSettingKey = (typeof FINANCIAL_SETTING_KEYS)[number];

export type FinancialSettingValue = number | boolean | string | null;

export type FinancialSettings = Partial<
  Record<FinancialSettingKey, FinancialSettingValue>
>;

/** Charge utile d'une demande : les valeurs voulues et celles qu'elles remplacent. */
export interface PlatformSettingsChangePayload {
  changes: FinancialSettings;
  before: FinancialSettings;
}

export function isFinancialSettingKey(key: string): key is FinancialSettingKey {
  return (FINANCIAL_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * Champs financiers du corps dont la valeur **diffère** de la valeur actuelle.
 * Une valeur identique n'est pas un changement : un formulaire qui renvoie
 * tous ses champs ne doit pas être refusé pour autant.
 */
export function financialChanges(
  current: PlatformSettings,
  body: Record<string, unknown>,
): FinancialSettings {
  const changes: FinancialSettings = {};
  for (const key of FINANCIAL_SETTING_KEYS) {
    if (!(key in body) || body[key] === undefined) continue;
    const next = body[key] as FinancialSettingValue;
    if (next !== current[key]) changes[key] = next;
  }
  return changes;
}

/** Valeurs actuelles des seuls champs visés par une demande. */
export function financialSnapshot(
  current: PlatformSettings,
  keys: readonly FinancialSettingKey[],
): FinancialSettings {
  return Object.fromEntries(
    keys.map((k) => [k, current[k]]),
  ) as FinancialSettings;
}

/**
 * Champs dont la valeur a bougé depuis la demande (approbation périmée).
 *
 * L'égalité stricte est fiable ici, y compris pour les `Float`
 * (`serviceFeePercent`, `restaurantCommissionPercent`) : la valeur n'est que
 * transportée (lue en base, stockée en JSONB, relue), jamais recalculée, et un
 * double fait l'aller-retour JSON à l'identique. Elle cesserait de l'être si
 * l'on arrondissait `before` avant de le stocker, ou si une colonne passait en
 * `Decimal` (objet, jamais `===` à un nombre) : revoir alors cette comparaison
 * et celle de `applyVendorCommissionChange`.
 */
export function staleFinancialKeys(
  current: PlatformSettings,
  before: FinancialSettings,
): FinancialSettingKey[] {
  return (Object.keys(before) as FinancialSettingKey[]).filter(
    (k) => current[k] !== before[k],
  );
}

export function financialSettingRequiresApproval(
  fields: FinancialSettingKey[],
): ConflictException {
  return new ConflictException({
    message:
      'Ce réglage touche l’argent : il se demande depuis l’admin web à jour et doit être approuvé par un second administrateur. Rien n’a été enregistré.',
    code: 'FINANCIAL_SETTING_REQUIRES_APPROVAL',
    fields,
  });
}

const LABELS: Record<FinancialSettingKey, string> = {
  serviceFeePercent: 'Frais de service',
  groceryServiceFeeBps: 'Frais de service épiceries',
  restaurantCommissionPercent: 'Commission par défaut',
  loyaltyPointValueXaf: 'Valeur du point',
  loyaltyPointsPerOrder: 'Points par commande',
  loyaltyMinRedemption: 'Seuil de dépense des points',
  referrerBonusPoints: 'Bonus de parrainage',
  vendorPayoutAutoEnabled: 'Versements automatiques',
  vendorPayoutDelayMinutes: 'Délai avant versement',
  deliveryPricingMode: 'Tarification de la livraison',
};

function formatValue(
  key: FinancialSettingKey,
  value: FinancialSettingValue,
): string {
  switch (key) {
    case 'serviceFeePercent':
    case 'restaurantCommissionPercent':
      return `${String(value)} %`;
    case 'groceryServiceFeeBps':
      return value === null ? 'taux général' : `${Number(value) / 100} %`;
    case 'loyaltyPointValueXaf':
      return `${String(value)} XAF`;
    case 'loyaltyPointsPerOrder':
    case 'loyaltyMinRedemption':
    case 'referrerBonusPoints':
      return `${String(value)} pts`;
    case 'vendorPayoutAutoEnabled':
      return value ? 'activés' : 'désactivés';
    case 'vendorPayoutDelayMinutes':
      return `${String(value)} min`;
    case 'deliveryPricingMode':
      return value === DeliveryPricingMode.PLATFORM
        ? 'grille plateforme'
        : 'prix du vendeur';
  }
}

/** « Frais de service : 15 % → 12 % ; Valeur du point : 50 XAF → 40 XAF ». */
export function describeFinancialChange(
  payload: PlatformSettingsChangePayload,
): string {
  return (Object.keys(payload.changes) as FinancialSettingKey[])
    .map(
      (k) =>
        `${LABELS[k]} : ${formatValue(k, payload.before[k] ?? null)} → ${formatValue(k, payload.changes[k] ?? null)}`,
    )
    .join(' ; ');
}

/**
 * F3-02 — en mode PLATFORM, un checkout sans grille publiée est refusé (jamais
 * de repli sur le prix du vendeur). Basculer sans grille fermerait la caisse
 * de toute la plateforme : c'est la bascule qu'on refuse. Le retour à
 * VENDOR_LEGACY, lui, n'exige rien — c'est la sortie de secours.
 *
 * Jugée à la demande ET à l'approbation : la grille peut avoir été dépubliée
 * entre les deux.
 */
export async function assertDeliveryPricingSwitch(
  client: Pick<Prisma.TransactionClient, 'deliveryTariff'>,
  current: DeliveryPricingMode,
  next: DeliveryPricingMode | undefined,
): Promise<void> {
  if (
    next !== DeliveryPricingMode.PLATFORM ||
    current === DeliveryPricingMode.PLATFORM
  ) {
    return;
  }
  const published = await client.deliveryTariff.count({
    where: { status: 'PUBLISHED' },
  });
  if (published === 0) {
    throw new ConflictException({
      message:
        'Publiez une grille de livraison avant de passer la tarification en mode plateforme.',
      code: 'DELIVERY_TARIFF_NOT_PUBLISHED',
    });
  }
}
