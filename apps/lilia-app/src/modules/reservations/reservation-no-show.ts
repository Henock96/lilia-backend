/**
 * 4B-2 J6 (OD-08 option D, OD-22 rouvert, 19/11) — partage de l'encaissement
 * d'une réservation dont le client ne s'est pas présenté.
 *
 * Entiers XAF de bout en bout (règle 5) ; le taux est en points de base, lu
 * dans `PlatformSettings.reservationNoShowVendorShareBps` (règle 6).
 *
 * - Part du restaurant = `total × taux`, arrondie à l'entier **inférieur** :
 *   un franc impair va à Lilia, jamais un franc de trop au restaurant.
 * - Toujours **strictement inférieure** au versement normal de la commande
 *   (`normalPayoutXaf`, ce qu'aurait touché le restaurant si le client était
 *   venu) : déclarer absent un client venu ne doit jamais rapporter plus que
 *   le servir (02-plan, risque de fraude). Bornée à `versement − 1`, et à 0
 *   si le versement normal est nul.
 * - Part de Lilia = le reste ; la somme vaut toujours le total (CHECK
 *   `ReservationNoShowSettlement_amounts_check`).
 */
export function noShowShares(
  totalXaf: number,
  vendorShareBps: number,
  normalPayoutXaf: number,
): { vendorShareXaf: number; platformShareXaf: number } {
  for (const [label, value] of [
    ['total', totalXaf],
    ['taux', vendorShareBps],
    ['versement normal', normalPayoutXaf],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Partage d'absence : ${label} invalide (${value})`);
    }
  }
  if (vendorShareBps > 9_999) {
    throw new Error(`Partage d'absence : taux ${vendorShareBps} ≥ 100 %`);
  }
  const byRate = Math.floor((totalXaf * vendorShareBps) / 10_000);
  const vendorShareXaf = Math.min(byRate, Math.max(0, normalPayoutXaf - 1));
  return { vendorShareXaf, platformShareXaf: totalXaf - vendorShareXaf };
}
