import { ConflictException } from '@nestjs/common';

import {
  RESERVATION_ACTORS,
  RESERVATION_STATUSES,
} from './reservation-booking-vocab';
import {
  assertReservationTransition,
  canTransition,
} from './reservation-state.machine';

/**
 * Règles métier écrites À LA MAIN (leçon B-1 : une spec qui dérive ses
 * attentes de la matrice ne prouve rien). Chaque ligne est une décision du
 * 03-approval §3 du Lot 4.
 */
describe('machine d’états des réservations — règles explicites', () => {
  const allowed: Array<[string, string, string]> = [
    ['PENDING', 'AWAITING_PAYMENT', 'RESTAURATEUR'],
    ['PENDING', 'DECLINED', 'RESTAURATEUR'],
    ['PENDING', 'EXPIRED', 'SYSTEM'],
    ['PENDING', 'CANCELLED_BY_CLIENT', 'CLIENT'],
    ['AWAITING_PAYMENT', 'CONFIRMED', 'SYSTEM'],
    ['AWAITING_PAYMENT', 'EXPIRED', 'SYSTEM'],
    ['AWAITING_PAYMENT', 'CANCELLED_BY_CLIENT', 'CLIENT'],
    ['AWAITING_PAYMENT', 'CANCELLED_BY_VENDOR', 'RESTAURATEUR'],
    ['CONFIRMED', 'HONORED', 'RESTAURATEUR'],
    ['CONFIRMED', 'NO_SHOW', 'RESTAURATEUR'],
    ['CONFIRMED', 'CANCELLED_BY_CLIENT', 'CLIENT'],
    ['CONFIRMED', 'CANCELLED_BY_VENDOR', 'RESTAURATEUR'],
    ['NO_SHOW', 'CONFIRMED', 'RESTAURATEUR'],
    // J6 (19/11) — annulation par le support, motif obligatoire.
    ['PENDING', 'CANCELLED_BY_VENDOR', 'ADMIN'],
    ['AWAITING_PAYMENT', 'CANCELLED_BY_VENDOR', 'ADMIN'],
    ['CONFIRMED', 'CANCELLED_BY_VENDOR', 'ADMIN'],
    ['NO_SHOW', 'CANCELLED_BY_VENDOR', 'ADMIN'],
  ];

  it.each(allowed)('%s → %s par %s : autorisé', (from, to, actor) => {
    expect(canTransition(from as never, to as never, actor as never)).toBe(
      true,
    );
  });

  it('seul le paiement (SYSTEM) confirme : ni le client, ni le vendeur, ni un admin', () => {
    for (const actor of ['CLIENT', 'RESTAURATEUR', 'ADMIN'] as const) {
      expect(canTransition('AWAITING_PAYMENT', 'CONFIRMED', actor)).toBe(false);
    }
  });

  it('le vendeur ne refuse plus une demande qu’il a acceptée', () => {
    expect(canTransition('AWAITING_PAYMENT', 'DECLINED', 'RESTAURATEUR')).toBe(
      false,
    );
  });

  it('une demande en attente ne saute pas le paiement', () => {
    expect(canTransition('PENDING', 'CONFIRMED', 'SYSTEM')).toBe(false);
    expect(canTransition('PENDING', 'HONORED', 'RESTAURATEUR')).toBe(false);
    expect(canTransition('PENDING', 'NO_SHOW', 'RESTAURATEUR')).toBe(false);
  });

  it('le client n’expire ni ne marque rien lui-même', () => {
    expect(canTransition('PENDING', 'EXPIRED', 'CLIENT')).toBe(false);
    expect(canTransition('CONFIRMED', 'HONORED', 'CLIENT')).toBe(false);
  });

  it('une absence ne se « retire » que vers CONFIRMED, et par le vendeur', () => {
    expect(canTransition('NO_SHOW', 'CONFIRMED', 'CLIENT')).toBe(false);
    expect(canTransition('NO_SHOW', 'HONORED', 'RESTAURATEUR')).toBe(false);
  });

  it('les états terminaux n’ont aucune sortie', () => {
    const terminals = [
      'DECLINED',
      'EXPIRED',
      'CANCELLED_BY_CLIENT',
      'CANCELLED_BY_VENDOR',
      'HONORED',
    ] as const;
    for (const from of terminals) {
      for (const to of RESERVATION_STATUSES) {
        for (const actor of RESERVATION_ACTORS) {
          expect(canTransition(from, to, actor)).toBe(false);
        }
      }
    }
  });

  it('exactement les 17 couples (transition, acteur) décidés, aucun autre', () => {
    let count = 0;
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        for (const actor of RESERVATION_ACTORS) {
          if (canTransition(from, to, actor)) count++;
        }
      }
    }
    expect(count).toBe(allowed.length);
  });

  it('assert : 409 avec un code stable', () => {
    expect(() =>
      assertReservationTransition('DECLINED', 'PENDING', 'RESTAURATEUR'),
    ).toThrow(ConflictException);
    try {
      assertReservationTransition('DECLINED', 'PENDING', 'RESTAURATEUR');
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({
        code: 'RESERVATION_STATE_CONFLICT',
      });
    }
  });
});
