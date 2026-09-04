import { Prisma } from '@prisma/client';

import {
  availableProductWhere,
  isWithinAvailabilityWindow,
} from './product-availability';
import {
  COLUMN_REF,
  FAKE_PRODUCT_TIME_FIELDS,
} from './product-availability.test-fields';

/**
 * La fenêtre de vente est décidée à **deux endroits** :
 *
 * - `isWithinAvailabilityWindow` — prédicat en mémoire, employé pour refuser un
 *   ajout au panier et pour expliquer le refus (`unavailabilityReason`) ;
 * - `availableProductWhere` — filtre SQL, qui décide de ce qui **apparaît** au
 *   catalogue.
 *
 * Deux implémentations d'une même règle finissent par diverger, et c'est arrivé :
 * sur les 49 combinaisons ci-dessous, **17 se contredisaient**. Toujours dans le
 * même sens — le SQL montrait des produits que le prédicat refusait ensuite au
 * panier : une viennoiserie « 06:00 → 07:00 » restait au catalogue toute la
 * journée, et une fenêtre « 20:00 → 22:00 » s'y trouvait dès 10 h du matin.
 *
 * Ce test ne vérifie pas laquelle des deux a raison — il exige qu'elles disent
 * la même chose. `product-availability.spec.ts` fixe, lui, la règle métier.
 */
describe('availableProductWhere ≡ isWithinAvailabilityWindow', () => {
  /** Un instant UTC dont on connaît l'heure locale (Brazzaville = UTC+1). */
  const at = (localHHmm: string) => {
    const [h, m] = localHHmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 7, 28, h - 1, m));
  };

  type Window = { availableFrom: string | null; availableUntil: string | null };

  /**
   * Rejoue le `where` Prisma sur une ligne, comme le ferait PostgreSQL.
   *
   * Les sentinelles de `COLUMN_REF` sont résolues contre la **ligne** — c'est
   * exactement ce que fait une référence de champ Prisma, qui se compile en nom
   * de colonne. Une comparaison dont un opérande est `NULL` est fausse, comme
   * en SQL.
   */
  function sqlMatches(where: Prisma.ProductWhereInput, row: Window): boolean {
    const resolve = (v: unknown): string | null => {
      if (v === COLUMN_REF.availableFrom) return row.availableFrom;
      if (v === COLUMN_REF.availableUntil) return row.availableUntil;
      return v as string | null;
    };

    const matchesField = (
      field: 'availableFrom' | 'availableUntil',
      condition: unknown,
    ): boolean => {
      if (condition === undefined) return true;
      const actual = row[field];
      if (condition === null) return actual === null;

      const c = condition as Record<string, unknown>;
      const operand = resolve(c.lte ?? c.gte ?? c.lt ?? c.gt);
      if (actual === null || operand === null) return false; // NULL en SQL
      if ('lte' in c) return actual <= operand;
      if ('gte' in c) return actual >= operand;
      if ('lt' in c) return actual < operand;
      if ('gt' in c) return actual > operand;
      return true;
    };

    const matchesClause = (clause: Prisma.ProductWhereInput): boolean => {
      if (Array.isArray(clause.AND)) {
        return clause.AND.every((c) =>
          matchesClause(c as Prisma.ProductWhereInput),
        );
      }
      return (
        matchesField('availableFrom', clause.availableFrom) &&
        matchesField('availableUntil', clause.availableUntil)
      );
    };

    return (where.OR as Prisma.ProductWhereInput[]).some(matchesClause);
  }

  const WINDOWS: Window[] = [
    { availableFrom: '06:00', availableUntil: '11:00' }, // matinée
    { availableFrom: '06:00', availableUntil: '07:00' }, // courte, tôt
    { availableFrom: '20:00', availableUntil: '22:00' }, // soirée
    { availableFrom: '18:00', availableUntil: '02:00' }, // à cheval sur minuit
    { availableFrom: null, availableUntil: '11:00' }, // borne haute seule
    { availableFrom: '18:00', availableUntil: null }, // borne basse seule
    { availableFrom: null, availableUntil: null }, // aucune fenêtre
  ];

  const HOURS = ['00:30', '03:00', '06:30', '10:00', '13:00', '19:00', '21:00'];

  for (const heure of HOURS) {
    for (const w of WINDOWS) {
      const label = `${w.availableFrom ?? '∅'} → ${w.availableUntil ?? '∅'}`;
      it(`à ${heure}, fenêtre ${label}`, () => {
        const now = at(heure);
        const sql = sqlMatches(
          availableProductWhere(FAKE_PRODUCT_TIME_FIELDS, now),
          w,
        );
        expect(sql).toBe(isWithinAvailabilityWindow(w, now));
      });
    }
  }
});
