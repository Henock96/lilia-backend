import {
  isWithinAvailabilityWindow,
  unavailabilityReason,
} from './product-availability';

/**
 * **Le contrat de fenêtre horaire, écrit une fois pour les trois plateformes.**
 *
 * La règle vit côté serveur (`isWithinAvailabilityWindow`) et le serveur la
 * publie sur chaque produit sous `availableNow`. L'application Flutter la
 * recopiait pourtant en Dart, avec deux erreurs :
 *
 * ```dart
 * return current.compareTo(availableFrom!) >= 0 &&
 *        current.compareTo(availableUntil!) <= 0;   // ✗
 * ```
 *
 * 1. une fenêtre « 22:00 → 02:00 » est **toujours fausse** : à 23:00,
 *    `"23:00" <= "02:00"` ne tient pas ;
 * 2. l'heure venait de `DateTime.now()`, c'est-à-dire du fuseau de l'appareil,
 *    quand le serveur raisonne en heure de Brazzaville (UTC+1).
 *
 * C'est exactement la divergence que le fix SQL d'août avait supprimée côté
 * serveur — 17 combinaisons sur 49 — réapparue côté client.
 *
 * ⚠️ **Ce tableau est le même que celui de
 * `lilia-app/test/models/availability_window_test.dart`.** Les deux
 * implémentations doivent rendre les mêmes verdicts sur les mêmes entrées ;
 * dupliquer le tableau est le prix à payer pour que deux langages puissent être
 * comparés. Toute ligne ajoutée ici doit l'être là-bas.
 */
describe('Contrat de fenêtre horaire (partagé avec Flutter)', () => {
  /** Une heure locale de Brazzaville (UTC+1), rendue en `Date` UTC. */
  const at = (hhmm: string): Date => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 8, 6, h - 1, m));
  };

  type Cas = {
    titre: string;
    from: string | null;
    until: string | null;
    heure: string;
    attendu: boolean;
  };

  const CAS: Cas[] = [
    // ─── Fenêtre de jour 10:00 → 18:00 ───────────────────────────────────────
    {
      titre: 'jour — au milieu',
      from: '10:00',
      until: '18:00',
      heure: '14:00',
      attendu: true,
    },
    {
      titre: 'jour — exactement à l’ouverture',
      from: '10:00',
      until: '18:00',
      heure: '10:00',
      attendu: true,
    },
    {
      titre: 'jour — exactement à la fermeture',
      from: '10:00',
      until: '18:00',
      heure: '18:00',
      attendu: true,
    },
    {
      titre: 'jour — une minute avant l’ouverture',
      from: '10:00',
      until: '18:00',
      heure: '09:59',
      attendu: false,
    },
    {
      titre: 'jour — une minute après la fermeture',
      from: '10:00',
      until: '18:00',
      heure: '18:01',
      attendu: false,
    },
    {
      titre: 'jour — en pleine nuit',
      from: '10:00',
      until: '18:00',
      heure: '03:00',
      attendu: false,
    },

    // ─── Fenêtre à cheval sur minuit 22:00 → 02:00 ───────────────────────────
    // Toute cette section était FAUSSE côté Flutter : la comparaison naïve
    // rendait `false` partout, donc un bar de nuit n'était jamais commandable.
    {
      titre: 'nuit — juste après l’ouverture',
      from: '22:00',
      until: '02:00',
      heure: '22:30',
      attendu: true,
    },
    {
      titre: 'nuit — exactement à l’ouverture',
      from: '22:00',
      until: '02:00',
      heure: '22:00',
      attendu: true,
    },
    {
      titre: 'nuit — après minuit',
      from: '22:00',
      until: '02:00',
      heure: '01:00',
      attendu: true,
    },
    {
      titre: 'nuit — exactement à la fermeture',
      from: '22:00',
      until: '02:00',
      heure: '02:00',
      attendu: true,
    },
    {
      titre: 'nuit — une minute après la fermeture',
      from: '22:00',
      until: '02:00',
      heure: '02:01',
      attendu: false,
    },
    {
      titre: 'nuit — une minute avant l’ouverture',
      from: '22:00',
      until: '02:00',
      heure: '21:59',
      attendu: false,
    },
    {
      titre: 'nuit — en plein après-midi',
      from: '22:00',
      until: '02:00',
      heure: '15:00',
      attendu: false,
    },

    // ─── Aucune fenêtre ──────────────────────────────────────────────────────
    {
      titre: 'aucun créneau — toujours disponible',
      from: null,
      until: null,
      heure: '03:00',
      attendu: true,
    },

    // ─── Borne unique ────────────────────────────────────────────────────────
    {
      titre: 'ouverture seule — avant',
      from: '08:00',
      until: null,
      heure: '07:00',
      attendu: false,
    },
    {
      titre: 'ouverture seule — après',
      from: '08:00',
      until: null,
      heure: '09:00',
      attendu: true,
    },
    {
      titre: 'fermeture seule — avant',
      from: null,
      until: '20:00',
      heure: '19:00',
      attendu: true,
    },
    {
      titre: 'fermeture seule — après',
      from: null,
      until: '20:00',
      heure: '21:00',
      attendu: false,
    },
  ];

  it.each(CAS)('$titre', ({ from, until, heure, attendu }) => {
    expect(
      isWithinAvailabilityWindow(
        { availableFrom: from, availableUntil: until },
        at(heure),
      ),
    ).toBe(attendu);
  });

  it('l’heure est celle de Brazzaville, pas celle du serveur', () => {
    // 23:30 UTC = 00:30 à Brazzaville → dans la fenêtre 22:00 → 02:00.
    const minuitTrente = new Date(Date.UTC(2026, 8, 6, 23, 30));
    expect(
      isWithinAvailabilityWindow(
        { availableFrom: '22:00', availableUntil: '02:00' },
        minuitTrente,
      ),
    ).toBe(true);
  });

  describe('produit indisponible — les quatre raisons, dans leur ordre de priorité', () => {
    const dansLaFenetre = at('12:00');

    it('retiré du catalogue passe avant tout le reste', () => {
      expect(
        unavailabilityReason(
          {
            nom: 'Poulet',
            deletedAt: new Date(),
            isAvailable: false,
            stockRestant: 0,
          },
          dansLaFenetre,
        ),
      ).toContain("n'est plus proposé à la vente");
    });

    it('marqué indisponible', () => {
      expect(
        unavailabilityReason(
          { nom: 'Poulet', isAvailable: false },
          dansLaFenetre,
        ),
      ).toContain('actuellement indisponible');
    });

    it('hors fenêtre, avec le créneau dans le message', () => {
      const raison = unavailabilityReason(
        { nom: 'Croissant', availableFrom: '06:00', availableUntil: '11:00' },
        dansLaFenetre,
      );
      expect(raison).toContain('de 06:00 à 11:00');
    });

    it('épuisé — et « illimité » n’est pas « épuisé »', () => {
      expect(
        unavailabilityReason({ nom: 'Poulet', stockRestant: 0 }, dansLaFenetre),
      ).toContain('est épuisé');
      expect(
        unavailabilityReason(
          { nom: 'Poulet', stockRestant: null },
          dansLaFenetre,
        ),
      ).toBeNull();
    });

    it('commandable → null', () => {
      expect(
        unavailabilityReason(
          { nom: 'Poulet', isAvailable: true, stockRestant: 5 },
          dansLaFenetre,
        ),
      ).toBeNull();
    });
  });
});
