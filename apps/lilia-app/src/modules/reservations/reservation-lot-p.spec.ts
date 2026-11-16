import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateReservationDto } from './dto/reservation-booking.dto';
import {
  AvailabilitySpace,
  effectiveLeadMin,
  paymentDeadline,
  responseDeadline,
  untenableReservation,
} from './reservation-availability';
import { ReservationsController } from './reservation-booking.controller';
import { RESERVATION_THROTTLES } from './reservation-booking-vocab';
import { VendorReservationsController } from './vendor-reservations.controller';

/** Lot P — corrections de 4B-1 (relevé du 21/10, décisions OD-01/02/12/17). */
const MIN = 60_000;
const NOW = new Date('2026-10-19T09:00:00Z');

describe('Lot P — bornes OD-02 (P-05)', () => {
  it('délai effectif : jamais moins de 60 min', () => {
    expect(effectiveLeadMin({ minLeadMin: 30 })).toBe(60);
    expect(effectiveLeadMin({ minLeadMin: 120 })).toBe(120);
  });

  it('réponse = min(demande + 30, arrivée − 30)', () => {
    const far = new Date(NOW.getTime() + 5 * 60 * MIN);
    expect(responseDeadline(NOW, far).getTime()).toBe(NOW.getTime() + 30 * MIN);
    const near = new Date(NOW.getTime() + 50 * MIN);
    expect(responseDeadline(NOW, near).getTime()).toBe(
      near.getTime() - 30 * MIN,
    );
  });

  it('paiement = min(acceptation + 15, arrivée − 10)', () => {
    const far = new Date(NOW.getTime() + 5 * 60 * MIN);
    expect(paymentDeadline(NOW, far).getTime()).toBe(NOW.getTime() + 15 * MIN);
    const near = new Date(NOW.getTime() + 20 * MIN);
    expect(paymentDeadline(NOW, near).getTime()).toBe(
      near.getTime() - 10 * MIN,
    );
  });
});

describe('Lot P — ressource qui ne tient plus ses réservations (P-02)', () => {
  const occ = (id: string, partySize: number, startMin: number) => ({
    reservationId: id,
    spaceId: 's',
    partySize,
    arrivalAt: new Date(NOW.getTime() + startMin * MIN),
    occupiedUntil: new Date(NOW.getTime() + (startMin + 105) * MIN),
  });
  const seats = (seatCount: number): AvailabilitySpace => ({
    id: 's',
    kind: 'SEATS',
    minGuests: null,
    maxGuests: null,
    seatCount,
    maxSeatsPerBooking: seatCount,
    position: 0,
  });
  const table = (maxGuests: number): AvailabilitySpace => ({
    id: 's',
    kind: 'TABLE',
    minGuests: 1,
    maxGuests,
    seatCount: null,
    maxSeatsPerBooking: null,
    position: 0,
  });

  it('8 → 4 places avec 3 + 3 qui se chevauchent : intenable', () => {
    const held = [occ('a', 3, 0), occ('b', 3, 30)];
    expect(untenableReservation(seats(8), held)).toBeNull();
    expect(untenableReservation(seats(4), held)?.reservationId).toBe('b');
  });

  it('deux groupes successifs qui ne se croisent pas tiennent dans 4 places', () => {
    expect(
      untenableReservation(seats(4), [occ('a', 3, 0), occ('b', 3, 200)]),
    ).toBeNull();
  });

  it('table réduite sous la taille du groupe : intenable', () => {
    expect(
      untenableReservation(table(2), [occ('a', 3, 0)])?.reservationId,
    ).toBe('a');
    expect(untenableReservation(table(3), [occ('a', 3, 0)])).toBeNull();
  });

  it('les réservations d’une autre ressource sont ignorées', () => {
    expect(
      untenableReservation(table(2), [{ ...occ('a', 6, 0), spaceId: 'x' }]),
    ).toBeNull();
  });
});

describe('Lot P — note sans caractère invisible (P-07)', () => {
  const noteErrors = async (note: string) =>
    (
      await validate(
        plainToInstance(CreateReservationDto, {
          restaurantId: 'v1',
          date: '2026-10-20',
          time: '12:00',
          partySize: 2,
          note,
        }),
      )
    ).filter((e) => e.property === 'note');

  it('U+200B, BOM et tabulation refusés', async () => {
    expect(await noteErrors('sans​espace')).toHaveLength(1);
    expect(await noteErrors('﻿note')).toHaveLength(1);
    expect(await noteErrors('a\tb')).toHaveLength(1);
  });

  it('texte accentué et retour à la ligne acceptés', async () => {
    expect(await noteErrors('Table près de la fenêtre\nmerci')).toHaveLength(0);
  });
});

describe('Lot P — limites de débit (P-06)', () => {
  // Métadonnées posées par `@Throttle` : `THROTTLER:LIMIT<nom>`.
  const limitOf = (target: object, name: 'short' | 'long') =>
    Reflect.getMetadata(`THROTTLER:LIMIT${name}`, target) as number | undefined;

  it.each(['accept', 'decline', 'cancel', 'noShow', 'undoNoShow', 'reassign'])(
    'geste vendeur %s : 5/s, 60/min',
    (method) => {
      const handler = (
        VendorReservationsController.prototype as unknown as Record<
          string,
          object
        >
      )[method];
      expect(limitOf(handler, 'short')).toBe(
        RESERVATION_THROTTLES.vendorGesture.short.limit,
      );
      expect(limitOf(handler, 'long')).toBe(
        RESERVATION_THROTTLES.vendorGesture.long.limit,
      );
    },
  );

  it('annulation client : 1/s, 10/min', () => {
    const handler = ReservationsController.prototype.cancel;
    expect(limitOf(handler, 'short')).toBe(1);
    expect(limitOf(handler, 'long')).toBe(10);
  });
});
