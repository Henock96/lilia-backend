import { VendorType } from '@prisma/client';

/**
 * Frais de service : **la** règle de taux, en un seul endroit (décision D-4,
 * 10/10/2026).
 *
 * Les épiceries ont leur taux propre (`PlatformSettings.groceryServiceFeeBps`),
 * commun à toutes ; les autres vendeurs gardent le taux général. Tant que le
 * taux épicerie n'est pas posé (`null`), les épiceries suivent le taux
 * général : le déploiement ne change aucun prix.
 *
 * Lu par le checkout (montant facturé) et par la vue panier (taux annoncé aux
 * clients, qui ne recalculent pas la règle — règle 2).
 */
export interface ServiceFeeSettings {
  serviceFeePercent: number;
  groceryServiceFeeBps: number | null;
}

/** Taux effectif, en points de base (1 % = 100 bps — règle 5). */
export function serviceFeeBasisPoints(
  settings: ServiceFeeSettings,
  vendorType: VendorType,
): number {
  if (
    vendorType === VendorType.GROCERY &&
    typeof settings.groceryServiceFeeBps === 'number'
  ) {
    return settings.groceryServiceFeeBps;
  }
  // Le taux général est stocké en pourcentage (`Float`, historique) : on le
  // ramène en points de base entiers une fois, ici, pour calculer en entiers.
  return Math.round(settings.serviceFeePercent * 100);
}

/** Pour l'affichage : 500 bps → 5 (%). */
export function serviceFeePercentOf(basisPoints: number): number {
  return basisPoints / 100;
}
