import { BadRequestException } from '@nestjs/common';
import { StockMode, StockPolicy } from '@prisma/client';

/**
 * F3-10 — politique de stock : le **seul** endroit qui écrit les colonnes de
 * stock d'un produit à partir d'une intention vendeur.
 *
 * ## Pourquoi une politique explicite
 *
 * Avant F3-10, trois états réels vivaient dans deux colonnes, dont un
 * implicite : `stockMode` (`DAILY` / `PERMANENT`) **et** « `stockQuotidien`
 * nul = illimité », dans les deux modes. Le vocabulaire (« reset »,
 * « permanent ») ne disait pas au vendeur ce qui allait se passer, et
 * `stockQuotidien` voulait dire « quota du jour » pour l'un, « dernier niveau
 * déclaré » pour l'autre.
 *
 * | Politique     | Vendeur               | Compteurs                                   |
 * |---------------|-----------------------|---------------------------------------------|
 * | `UNLIMITED`   | Toujours disponible   | aucun                                       |
 * | `DAILY_QUOTA` | Quantité du jour      | `stockQuotidien` = quota, `stockRestant` = reste |
 * | `INVENTORY`   | Stock réel            | `stockRestant` = unités à vendre            |
 *
 * La base refuse toute contradiction (CHECK `Product_stock_policy_consistent`).
 *
 * ## Compatibilité
 *
 * Les applications vendeurs installées envoient encore `stockMode` +
 * `stockQuotidien` ; on les traduit ici. `stockMode` reste écrit (double
 * écriture) pour qu'un retour arrière et les applications installées relisent
 * une valeur juste.
 */

export interface StockIntent {
  stockPolicy?: StockPolicy;
  stockMode?: StockMode;
  /** Quota (DAILY_QUOTA) ou niveau (INVENTORY) ; `null` = illimité (ancien contrat). */
  stockQuotidien?: number | null;
}

export interface StockColumns {
  stockPolicy: StockPolicy;
  stockMode: StockMode;
  stockQuotidien: number | null;
  stockRestant: number | null;
  stockResetAt?: Date | null;
}

/** `stockMode` écrit en double pour les lecteurs d'avant F3-10. */
export function stockModeFor(
  policy: StockPolicy,
  fallback: StockMode,
): StockMode {
  if (policy === 'DAILY_QUOTA') return 'DAILY';
  if (policy === 'INVENTORY') return 'PERMANENT';
  return fallback;
}

/** Traduction de l'ancien contrat (`stockMode` + `stockQuotidien`). */
export function legacyPolicy(
  mode: StockMode | undefined,
  units: number | null | undefined,
): StockPolicy {
  if (units === null || units === undefined) return 'UNLIMITED';
  return mode === 'PERMANENT' ? 'INVENTORY' : 'DAILY_QUOTA';
}

function requireUnits(
  policy: StockPolicy,
  units: number | null | undefined,
): number {
  if (units === null || units === undefined) {
    throw new BadRequestException({
      message:
        policy === 'DAILY_QUOTA'
          ? 'Indiquez la quantité préparée chaque jour.'
          : 'Indiquez le nombre d’unités en stock.',
      code: 'STOCK_UNITS_REQUIRED',
    });
  }
  return units;
}

/** Colonnes d'un produit neuf. */
export function stockColumnsForCreate(
  intent: StockIntent,
  now: Date = new Date(),
): StockColumns {
  const policy =
    intent.stockPolicy ?? legacyPolicy(intent.stockMode, intent.stockQuotidien);
  const mode = stockModeFor(policy, intent.stockMode ?? 'DAILY');
  if (policy === 'UNLIMITED') {
    return {
      stockPolicy: policy,
      stockMode: mode,
      stockQuotidien: null,
      stockRestant: null,
    };
  }
  const units = requireUnits(policy, intent.stockQuotidien);
  return {
    stockPolicy: policy,
    stockMode: mode,
    stockQuotidien: units,
    stockRestant: units,
    stockResetAt: policy === 'DAILY_QUOTA' ? now : null,
  };
}

export interface CurrentStock {
  stockPolicy: StockPolicy;
  stockMode: StockMode;
  stockQuotidien: number | null;
  stockRestant: number | null;
}

/**
 * Ce que `PATCH /products/:id` doit écrire, ou `null` si la fiche ne touche
 * pas au stock.
 *
 * `quotaChange` : le quota d'un `DAILY_QUOTA` change sans changer de
 * politique. Le reste ne se réaligne **pas** sur le nouveau quota (cela
 * ressusciterait ce qui a été vendu aujourd'hui) : il suit l'écart, en SQL,
 * borné à 0 — voir `ProductCommandService.update`.
 *
 * Règle S-1 conservée : renvoyer la même valeur ne réaligne rien. Les deux
 * formulaires envoient la fiche entière à chaque enregistrement ; un
 * enregistrement pour corriger une description ne doit pas toucher au stock.
 */
export function planStockUpdate(
  current: CurrentStock,
  intent: StockIntent,
  now: Date = new Date(),
): { data: Partial<StockColumns>; quotaChange?: number } | null {
  const touched =
    intent.stockPolicy !== undefined ||
    intent.stockMode !== undefined ||
    intent.stockQuotidien !== undefined;
  if (!touched) return null;

  const units =
    intent.stockQuotidien !== undefined
      ? intent.stockQuotidien
      : (current.stockQuotidien ?? current.stockRestant);
  const policy =
    intent.stockPolicy ??
    legacyPolicy(intent.stockMode ?? current.stockMode, units);
  const mode = stockModeFor(policy, intent.stockMode ?? current.stockMode);

  if (policy === 'UNLIMITED') {
    if (current.stockPolicy === 'UNLIMITED' && mode === current.stockMode)
      return null;
    return {
      data: {
        stockPolicy: policy,
        stockMode: mode,
        stockQuotidien: null,
        stockRestant: null,
      },
    };
  }

  const value = requireUnits(policy, units);
  if (policy !== current.stockPolicy) {
    return {
      data: {
        stockPolicy: policy,
        stockMode: mode,
        stockQuotidien: value,
        stockRestant: value,
        stockResetAt: policy === 'DAILY_QUOTA' ? now : null,
      },
    };
  }

  const unitsChanged =
    intent.stockQuotidien !== undefined &&
    intent.stockQuotidien !== current.stockQuotidien;
  const modeChanged = mode !== current.stockMode;
  if (!unitsChanged) return modeChanged ? { data: { stockMode: mode } } : null;

  if (policy === 'DAILY_QUOTA') {
    return { data: { stockMode: mode }, quotaChange: value };
  }
  // INVENTORY : le vendeur déclare un nouveau niveau (ancien contrat).
  return {
    data: { stockMode: mode, stockQuotidien: value, stockRestant: value },
  };
}
