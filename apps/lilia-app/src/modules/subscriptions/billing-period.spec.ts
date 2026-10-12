import { addOneCalendarMonth } from './billing-period';

/**
 * Un mois calendaire à l'heure de Brazzaville (UTC+1). Chaque attente est
 * écrite à la main, en heure locale : « 11/10 10:00 → 11/11 10:00 ».
 */
describe('addOneCalendarMonth (heure de Brazzaville)', () => {
  /** Instant UTC correspondant à une heure locale de Brazzaville. */
  const bzv = (iso: string) => new Date(`${iso}+01:00`);

  it('même quantième, même heure, mois suivant', () => {
    expect(addOneCalendarMonth(bzv('2026-10-11T10:00:00'))).toEqual(
      bzv('2026-11-11T10:00:00'),
    );
  });

  it('31 janvier → 28 février (année commune)', () => {
    expect(addOneCalendarMonth(bzv('2027-01-31T09:30:00'))).toEqual(
      bzv('2027-02-28T09:30:00'),
    );
  });

  it('31 janvier → 29 février (année bissextile)', () => {
    expect(addOneCalendarMonth(bzv('2028-01-31T09:30:00'))).toEqual(
      bzv('2028-02-29T09:30:00'),
    );
  });

  it('31 mars → 30 avril, jamais le 1er mai', () => {
    expect(addOneCalendarMonth(bzv('2027-03-31T18:00:00'))).toEqual(
      bzv('2027-04-30T18:00:00'),
    );
  });

  it('décembre → janvier de l’année suivante', () => {
    expect(addOneCalendarMonth(bzv('2026-12-15T12:00:00'))).toEqual(
      bzv('2027-01-15T12:00:00'),
    );
  });

  it('juste après minuit à Brazzaville : le jour LOCAL est conservé', () => {
    // 1er novembre 00:30 à Brazzaville = 31 octobre 23:30 UTC. Compter en
    // UTC donnerait « 30 novembre » ; le vendeur a payé le 1er.
    expect(addOneCalendarMonth(bzv('2026-11-01T00:30:00'))).toEqual(
      bzv('2026-12-01T00:30:00'),
    );
  });

  it('31 octobre 23:30 à Brazzaville → 30 novembre 23:30', () => {
    expect(addOneCalendarMonth(bzv('2026-10-31T23:30:00'))).toEqual(
      bzv('2026-11-30T23:30:00'),
    );
  });

  it('les millisecondes sont conservées', () => {
    expect(addOneCalendarMonth(bzv('2026-10-11T10:00:00.123'))).toEqual(
      bzv('2026-11-11T10:00:00.123'),
    );
  });
});
