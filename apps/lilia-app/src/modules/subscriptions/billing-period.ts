/**
 * Premium (Lot 2) — une période d'abonnement = **un mois calendaire**, compté
 * à l'heure de Brazzaville (décision du 11/10/2026).
 *
 * Brazzaville est à UTC+1 toute l'année, sans heure d'été : le décalage est
 * fixe, donc un simple aller-retour suffit — pas de base de fuseaux.
 *
 * Le jour du mois est conservé ; s'il n'existe pas dans le mois d'arrivée, on
 * prend le dernier jour de ce mois, à la même heure. 31/01 → 28/02 (29 en
 * année bissextile), 31/03 → 30/04. Pas de débordement sur le mois suivant :
 * `Date.setUTCMonth` seul rendrait le 03/03 pour un 31/01.
 */
const BRAZZAVILLE_OFFSET_MS = 60 * 60 * 1000;

export function addOneCalendarMonth(start: Date): Date {
  const local = new Date(start.getTime() + BRAZZAVILLE_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1; // mois d'arrivée (peut valoir 12)
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(local.getUTCDate(), lastDay);
  const endLocal = Date.UTC(
    year,
    month,
    day,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(endLocal - BRAZZAVILLE_OFFSET_MS);
}
