import {
  brazzavilleDateKey,
  brazzavilleHour,
  startOfDaysAgo,
  startOfPeriod,
} from './brazzaville-time';

/**
 * Lot 5 (DASH-03) — les bornes du tableau de bord suivent l'heure de
 * Brazzaville (UTC+1, sans heure d'été), pas le fuseau du serveur.
 */
describe('Bornes de période à l’heure de Brazzaville', () => {
  // Vendredi 23/10/2026, 00 h 30 à Brazzaville = jeudi 22/10, 23 h 30 UTC.
  const justAfterLocalMidnight = new Date('2026-10-22T23:30:00.000Z');

  it('« aujourd’hui » commence à minuit à Brazzaville, pas à minuit UTC', () => {
    expect(startOfPeriod('today', justAfterLocalMidnight)?.toISOString()).toBe(
      '2026-10-22T23:00:00.000Z',
    );
  });

  it('une commande livrée à 00 h 30 compte pour le jour qui commence', () => {
    expect(brazzavilleDateKey(justAfterLocalMidnight)).toBe('2026-10-23');
    expect(brazzavilleHour(justAfterLocalMidnight)).toBe(0);
  });

  it('semaine depuis dimanche, mois et année au premier jour', () => {
    // Vendredi 23/10 → dimanche 18/10 à minuit local.
    expect(startOfPeriod('week', justAfterLocalMidnight)?.toISOString()).toBe(
      '2026-10-17T23:00:00.000Z',
    );
    expect(startOfPeriod('month', justAfterLocalMidnight)?.toISOString()).toBe(
      '2026-09-30T23:00:00.000Z',
    );
    expect(startOfPeriod('year', justAfterLocalMidnight)?.toISOString()).toBe(
      '2025-12-31T23:00:00.000Z',
    );
  });

  it('début de mois franchi en arrière (1er du mois, semaine à cheval)', () => {
    // Jeudi 1er/10/2026, 10 h locale → dimanche 27/09.
    const firstOfMonth = new Date('2026-10-01T09:00:00.000Z');
    expect(startOfPeriod('week', firstOfMonth)?.toISOString()).toBe(
      '2026-09-26T23:00:00.000Z',
    );
  });

  it('période inconnue ou absente → pas de borne', () => {
    expect(startOfPeriod(undefined, justAfterLocalMidnight)).toBeNull();
    expect(startOfPeriod('decade', justAfterLocalMidnight)).toBeNull();
  });

  it('N jours avant aujourd’hui, à minuit local', () => {
    expect(startOfDaysAgo(30, justAfterLocalMidnight).toISOString()).toBe(
      '2026-09-22T23:00:00.000Z',
    );
  });
});
