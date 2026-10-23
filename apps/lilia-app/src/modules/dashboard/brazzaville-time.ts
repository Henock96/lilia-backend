/**
 * Bornes de période du tableau de bord, à l'heure de Brazzaville (DASH-03).
 *
 * Les bornes étaient calculées avec `setHours(0, 0, 0, 0)`, au fuseau du
 * processus — UTC sur Render : « aujourd'hui » commençait à 01 h à Brazzaville,
 * et une commande livrée entre minuit et 1 h comptait pour la veille. Même
 * décalage pour les clés du graphique et les heures de pointe.
 *
 * Brazzaville vit en WAT, UTC+1, **sans heure d'été** : un décalage fixe suffit
 * et ne dépend pas des données de fuseau du conteneur. Le web fait de même
 * (`brazzavilleDateString`).
 */
const OFFSET_MS = 60 * 60 * 1000;

function local(now: Date) {
  const l = new Date(now.getTime() + OFFSET_MS);
  return {
    y: l.getUTCFullYear(),
    m: l.getUTCMonth(),
    d: l.getUTCDate(),
    dow: l.getUTCDay(),
  };
}

/** Instant UTC du minuit de Brazzaville du jour (y, m, d) — d peut déborder. */
function midnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - OFFSET_MS);
}

export type DashboardPeriod = 'today' | 'week' | 'month' | 'year';

/**
 * Début de la période, à l'heure de Brazzaville. La semaine commence le
 * dimanche, comme avant. `null` pour une période inconnue ou absente.
 */
export function startOfPeriod(
  period: string | undefined,
  now: Date = new Date(),
): Date | null {
  const { y, m, d, dow } = local(now);
  switch (period) {
    case 'today':
      return midnight(y, m, d);
    case 'week':
      return midnight(y, m, d - dow);
    case 'month':
      return midnight(y, m, 1);
    case 'year':
      return midnight(y, 0, 1);
    default:
      return null;
  }
}

/** Minuit de Brazzaville, [days] jours avant aujourd'hui. */
export function startOfDaysAgo(days: number, now: Date = new Date()): Date {
  const { y, m, d } = local(now);
  return midnight(y, m, d - days);
}

/** Date calendaire à Brazzaville, `AAAA-MM-JJ`. */
export function brazzavilleDateKey(date: Date): string {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Heure (0-23) à Brazzaville. */
export function brazzavilleHour(date: Date): number {
  return new Date(date.getTime() + OFFSET_MS).getUTCHours();
}
