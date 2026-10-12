import { Entitlement, PLAN_ENTITLEMENTS, SubscriptionPlan } from './plans';

/** Ce qu'il faut d'une période pour décider si elle compte. */
export interface PeriodLike {
  plan: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Une période donne-t-elle un droit à l'instant `now` ?
 *
 * **Seule définition** de « abonné » dans le système : `ACTIVE` et
 * `startsAt ≤ now < endsAt`. La fin est exclue — à `endsAt` exactement, le
 * vendeur n'est plus Premium. Calculée à chaque lecture : aucun drapeau ni
 * cron ne peut rester « Premium » après l'échéance.
 */
export function isPeriodActive(period: PeriodLike, now: Date): boolean {
  return (
    period.status === 'ACTIVE' &&
    period.startsAt.getTime() <= now.getTime() &&
    now.getTime() < period.endsAt.getTime()
  );
}

export interface SubscriptionVerdict {
  /** Formule active, `null` pour un vendeur Standard. */
  plan: SubscriptionPlan | null;
  active: boolean;
  /** Fin de la période active, `null` si aucune. */
  currentPeriodEndsAt: Date | null;
  /**
   * Fin de la dernière période déjà payée (prolongations comprises) —
   * « Premium jusqu'au… ». `null` si aucune période active ni à venir.
   * Exact parce que les périodes actives forment une suite continue :
   * l'attribution s'empile à la fin, la révocation part du dernier mois
   * (`VendorSubscriptionService.revoke`) — aucun trou ne peut s'y glisser.
   */
  paidUntil: Date | null;
  entitlements: Entitlement[];
}

/**
 * Verdict serveur pour un vendeur, à partir de toutes ses périodes. Les
 * clients l'affichent ; ils ne le recalculent jamais (règle 2).
 */
export function subscriptionVerdict(
  periods: readonly PeriodLike[],
  now: Date,
): SubscriptionVerdict {
  const current = periods.find((p) => isPeriodActive(p, now));
  const paidUntil = periods
    .filter((p) => p.status === 'ACTIVE' && p.endsAt.getTime() > now.getTime())
    .reduce<Date | null>(
      (max, p) => (max == null || p.endsAt > max ? p.endsAt : max),
      null,
    );
  if (!current) {
    return {
      plan: null,
      active: false,
      currentPeriodEndsAt: null,
      paidUntil,
      entitlements: [],
    };
  }
  const plan = current.plan as SubscriptionPlan;
  return {
    plan,
    active: true,
    currentPeriodEndsAt: current.endsAt,
    paidUntil,
    entitlements: [...(PLAN_ENTITLEMENTS[plan] ?? [])],
  };
}

export function hasEntitlement(
  verdict: SubscriptionVerdict,
  entitlement: Entitlement,
): boolean {
  return verdict.entitlements.includes(entitlement);
}
