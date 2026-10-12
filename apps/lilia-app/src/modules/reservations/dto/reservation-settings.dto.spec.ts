import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { evaluateReservationDraft } from '../reservation-config';
import { ReservationSpaceDto } from './reservation-settings.dto';

/**
 * Libellés : aucun caractère invisible ou de contrôle. Un espace de largeur
 * nulle (U+200B) rendrait « Terrasse » et « Terrasse » suivi de ce caractère
 * distincts pour l'unicité (D15) tout en étant identiques à l'écran ; un
 * U+202E renverserait le texte.
 *
 * Le refus est porté par le MOTEUR (constat `LABEL_INVALID_CHARS` sous
 * `spaces[i].label`), pas par le DTO : un 400 de validation DTO n'a ni
 * `error.code` ni champ, et l'app vendeurs ne pourrait pas dire quelle table
 * corriger. Le DTO ne contrôle que la forme.
 *
 * Les caractères sont construits par code (`String.fromCharCode`) : aucun
 * caractère invisible littéral dans ce fichier.
 */
const c = (code: number) => String.fromCharCode(code);

const invalid: Array<[string, string]> = [
  ['C0 (U+0007)', `Table${c(0x07)}`],
  ['DEL (U+007F)', `Table${c(0x7f)}`],
  ['C1 (U+0085)', `Table${c(0x85)}`],
  ['espace de largeur nulle (U+200B)', `Terrasse${c(0x200b)}`],
  ['liant de largeur nulle (U+200D)', `Ter${c(0x200d)}rasse`],
  ['BOM (U+FEFF)', `${c(0xfeff)}Terrasse`],
  ['inversion bidi (U+202E)', `Table ${c(0x202e)}1`],
  ['seul caractère invisible', c(0x200b)],
];
const valid: Array<[string, string]> = [
  ['accents', 'Été — terrasse'],
  ['emoji simple', 'Terrasse 🌴'],
  ['espaces multiples (normalisés plus loin)', ' Table   1 '],
];

const evaluate = (label: string) =>
  evaluateReservationDraft(
    {
      enabled: false,
      slotDurationMin: 90,
      slotStepMin: 30,
      bufferMin: 15,
      minLeadMin: 120,
      maxAdvanceDays: 30,
      maxPartySize: 4,
      spaces: [
        { kind: 'TABLE', label: 'Fenêtre', minGuests: 1, maxGuests: 4 },
        { kind: 'TABLE', label, minGuests: 1, maxGuests: 4 },
      ],
      windows: [],
    },
    {
      existingSpaces: [],
      openingHours: [],
      platformEnabled: false,
      entitled: true,
    },
  );

describe('libellés : caractères invisibles ou de contrôle', () => {
  it.each(invalid)(
    'moteur : %s → LABEL_INVALID_CHARS sous spaces[1].label',
    (_, label) => {
      const r = evaluate(label);
      expect(r.hasErrors).toBe(true);
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          severity: 'ERROR',
          code: 'LABEL_INVALID_CHARS',
          field: 'spaces[1].label',
        }),
      );
      // Rien n'est prévu pour cette ressource.
      expect(r.plannedSpaces.map((s) => s.position)).toEqual([0]);
    },
  );

  it.each(valid)('moteur : %s accepté', (_, label) => {
    const r = evaluate(label);
    expect(r.hasErrors).toBe(false);
    expect(r.plannedSpaces.map((s) => s.position)).toEqual([0, 1]);
  });

  it.each([...invalid, ...valid])(
    'DTO : %s laissé au moteur (forme seulement)',
    async (_, label) => {
      const errors = await validate(
        plainToInstance(ReservationSpaceDto, {
          kind: 'TABLE',
          label,
          minGuests: 1,
          maxGuests: 4,
        }),
      );
      expect(errors).toEqual([]);
    },
  );
});
