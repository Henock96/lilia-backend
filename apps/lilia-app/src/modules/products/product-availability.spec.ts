import {
  availableProductWhere,
  isWithinAvailabilityWindow,
  localTimeHHmm,
  unavailabilityReason,
} from './product-availability';

/**
 * Disponibilité produit (fixes M1 et M2 — audit du 28/08/2026).
 *
 * M1 : `availableFrom` / `availableUntil` étaient validés à l'écriture puis
 * jamais relus. La fonctionnalité BAKERY de LIL-111 ne marchait pas : une
 * viennoiserie « 06:00 → 11:00 » restait commandable à 3 h du matin.
 */
describe('product-availability', () => {
  /** Un instant UTC dont on connaît l'heure locale (Brazzaville = UTC+1). */
  const at = (localHHmm: string) => {
    const [h, m] = localHHmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 7, 28, h - 1, m));
  };

  it('convertit en heure locale UTC+1', () => {
    expect(localTimeHHmm(new Date(Date.UTC(2026, 7, 28, 2, 5)))).toBe('03:05');
    // Passage de minuit : 23:30 UTC = 00:30 locale le lendemain.
    expect(localTimeHHmm(new Date(Date.UTC(2026, 7, 28, 23, 30)))).toBe(
      '00:30',
    );
  });

  describe('fenêtre classique 06:00 → 11:00 (viennoiserie)', () => {
    const croissant = { availableFrom: '06:00', availableUntil: '11:00' };

    it.each(['06:00', '08:30', '11:00'])('disponible à %s', (t) => {
      expect(isWithinAvailabilityWindow(croissant, at(t))).toBe(true);
    });

    it.each(['03:00', '05:59', '11:01', '23:00'])(
      'indisponible à %s (le cas de l’audit)',
      (t) => {
        expect(isWithinAvailabilityWindow(croissant, at(t))).toBe(false);
      },
    );
  });

  describe('fenêtre à cheval sur minuit 18:00 → 02:00', () => {
    const nuit = { availableFrom: '18:00', availableUntil: '02:00' };

    it.each(['18:00', '23:59', '00:30', '02:00'])('disponible à %s', (t) => {
      expect(isWithinAvailabilityWindow(nuit, at(t))).toBe(true);
    });

    it.each(['02:01', '12:00', '17:59'])('indisponible à %s', (t) => {
      expect(isWithinAvailabilityWindow(nuit, at(t))).toBe(false);
    });
  });

  it('sans fenêtre déclarée, toujours disponible', () => {
    expect(isWithinAvailabilityWindow({}, at('03:00'))).toBe(true);
    expect(
      isWithinAvailabilityWindow(
        { availableFrom: null, availableUntil: null },
        at('03:00'),
      ),
    ).toBe(true);
  });

  it('borne unique : uniquement `from` ou uniquement `until`', () => {
    expect(
      isWithinAvailabilityWindow({ availableFrom: '10:00' }, at('12:00')),
    ).toBe(true);
    expect(
      isWithinAvailabilityWindow({ availableFrom: '10:00' }, at('09:00')),
    ).toBe(false);
    expect(
      isWithinAvailabilityWindow({ availableUntil: '10:00' }, at('09:00')),
    ).toBe(true);
    expect(
      isWithinAvailabilityWindow({ availableUntil: '10:00' }, at('11:00')),
    ).toBe(false);
  });

  describe('unavailabilityReason — message rendu au client', () => {
    it('produit retiré du catalogue (M2)', () => {
      expect(
        unavailabilityReason({ nom: 'Pain', deletedAt: new Date() }),
      ).toContain("n'est plus proposé");
    });

    it('produit marqué indisponible (M2)', () => {
      expect(
        unavailabilityReason({ nom: 'Pain', isAvailable: false }),
      ).toContain('indisponible');
    });

    it('hors fenêtre horaire, avec le créneau dans le message (M1)', () => {
      const reason = unavailabilityReason(
        { nom: 'Croissant', availableFrom: '06:00', availableUntil: '11:00' },
        at('03:00'),
      );
      expect(reason).toContain('06:00');
      expect(reason).toContain('11:00');
    });

    it('produit commandable → null', () => {
      expect(
        unavailabilityReason(
          {
            nom: 'Croissant',
            isAvailable: true,
            deletedAt: null,
            availableFrom: '06:00',
            availableUntil: '11:00',
          },
          at('08:00'),
        ),
      ).toBeNull();
    });
  });

  it('le filtre Prisma exclut les produits retirés et indisponibles', () => {
    const where = availableProductWhere(at('08:00'));
    expect(where.deletedAt).toBeNull();
    expect(where.isAvailable).toBe(true);
    // Une branche par forme de fenêtre, dont le cas « à cheval sur minuit ».
    expect(Array.isArray(where.OR)).toBe(true);
    expect((where.OR as unknown[]).length).toBeGreaterThanOrEqual(4);
  });
});
