/**
 * Préparation de la bascule `PLATFORM` (durcissement lot 4, audit §8.2).
 *
 * La cible est un prix **par couple de quartiers** (quartier du vendeur →
 * quartier du client) ; les tranches de distance ne servent qu'en repli. Ce
 * module dit, pour une version de grille, quels couples seraient chiffrés et
 * comment — sans rien écrire. Pur : l'état de la base lui est passé.
 *
 * Même ordre que `quoteDelivery` (`delivery-pricing.engine.ts`) :
 *  - `OVERRIDE` : un prix fixe existe pour le couple ;
 *  - `BAND`     : pas de prix fixe, mais des tranches et deux positions
 *                 connues (centroïdes, ou GPS du vendeur) ;
 *  - `FALLBACK` : ni l'un ni l'autre — le moteur ne refuse pas la commande,
 *                 il applique un prix de repli. C'est ce qu'une grille prête
 *                 ne doit plus jamais produire.
 */

export interface ReadinessQuartier {
  id: string;
  nom: string;
  hasCentroid: boolean;
}

export interface ReadinessVendor {
  id: string;
  nom: string;
  quartierId: string | null;
  hasGps: boolean;
}

export interface ReadinessTariff {
  bandsCount: number;
  overrides: ReadonlyArray<{
    originQuartierId: string;
    destQuartierId: string;
  }>;
}

export type PairBasis = 'OVERRIDE' | 'BAND' | 'FALLBACK';

export interface ReadinessPair {
  originQuartierId: string;
  destQuartierId: string;
  basis: PairBasis;
}

export interface TariffReadiness {
  /** Aucun vendeur hors grille et aucun couple au repli. */
  ready: boolean;
  quartiersWithoutCentroid: Array<{ id: string; nom: string }>;
  /** Vendeurs visibles sans quartier : aucun prix fixe ne peut les viser. */
  vendorsWithoutQuartier: Array<{ id: string; nom: string }>;
  counts: Record<PairBasis, number> & { pairs: number };
  /**
   * Couples sans prix fixe (base `BAND` ou `FALLBACK`), origines = quartiers
   * des vendeurs visibles. Ce que l'éditeur en matrice signale.
   */
  missingOverrides: ReadinessPair[];
}

export function tariffReadiness(input: {
  quartiers: readonly ReadinessQuartier[];
  vendors: readonly ReadinessVendor[];
  tariff: ReadinessTariff;
}): TariffReadiness {
  const { quartiers, vendors, tariff } = input;
  const byId = new Map(quartiers.map((q) => [q.id, q]));
  const overrides = new Set(
    tariff.overrides.map((o) => `${o.originQuartierId}|${o.destQuartierId}`),
  );

  // Une origine est « positionnée » si son centroïde est connu, ou si TOUS
  // ses vendeurs ont un GPS (le moteur mesure alors depuis le vendeur).
  const origins = new Map<string, boolean>();
  for (const v of vendors) {
    if (!v.quartierId || !byId.has(v.quartierId)) continue;
    const centroid = byId.get(v.quartierId)!.hasCentroid;
    const placed = centroid || v.hasGps;
    origins.set(v.quartierId, (origins.get(v.quartierId) ?? true) && placed);
  }

  const counts = { OVERRIDE: 0, BAND: 0, FALLBACK: 0, pairs: 0 };
  const missingOverrides: ReadinessPair[] = [];
  for (const [originQuartierId, originPlaced] of origins) {
    for (const dest of quartiers) {
      const pair = { originQuartierId, destQuartierId: dest.id };
      let basis: PairBasis;
      if (overrides.has(`${originQuartierId}|${dest.id}`)) basis = 'OVERRIDE';
      else if (tariff.bandsCount > 0 && originPlaced && dest.hasCentroid)
        basis = 'BAND';
      else basis = 'FALLBACK';
      counts[basis] += 1;
      counts.pairs += 1;
      if (basis !== 'OVERRIDE') missingOverrides.push({ ...pair, basis });
    }
  }

  const vendorsWithoutQuartier = vendors
    .filter((v) => !v.quartierId || !byId.has(v.quartierId))
    .map(({ id, nom }) => ({ id, nom }));

  return {
    // Rien d'évalué (aucun vendeur visible, aucun quartier) n'est pas « prêt ».
    ready:
      counts.pairs > 0 &&
      vendorsWithoutQuartier.length === 0 &&
      counts.FALLBACK === 0,
    quartiersWithoutCentroid: quartiers
      .filter((q) => !q.hasCentroid)
      .map(({ id, nom }) => ({ id, nom })),
    vendorsWithoutQuartier,
    counts,
    missingOverrides,
  };
}
