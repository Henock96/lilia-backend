import { DayOfWeek, Prisma, ReservationSettings } from '@prisma/client';

import {
  arrivalInstant,
  AvailabilitySpace,
  DayContext,
  dayOfWeekOf,
} from './reservation-availability';
import { CAPACITY_HOLDING_STATUSES } from './reservation-booking-vocab';
import { RESERVATION_LIMITS, ReservationSpaceKind } from './reservation-vocab';

type Db = Prisma.TransactionClient;

/**
 * Plusieurs lectures indépendantes : en parallèle hors transaction (latence
 * Render ↔ Neon), **en série dans une transaction** — une transaction tient
 * une seule connexion, et `pg` refuse d'y lancer deux requêtes à la fois
 * (« client.query() when the client is already executing a query »,
 * supprimé en pg@9).
 */
export async function readTogether<T extends readonly unknown[]>(
  inTransaction: boolean,
  reads: { [K in keyof T]: () => Promise<T[K]> },
): Promise<T> {
  if (!inTransaction) {
    return (await Promise.all(reads.map((read) => read()))) as unknown as T;
  }
  const results: unknown[] = [];
  for (const read of reads) results.push(await read());
  return results as unknown as T;
}

const MINUTE_MS = 60_000;
/** Occupation la plus longue possible : durée max + marge max (D5, D7). */
const MAX_OCCUPANCY_MS =
  (RESERVATION_LIMITS.slotDurationMin.max + RESERVATION_LIMITS.bufferMin.max) *
  MINUTE_MS;

/**
 * Lot 4 — tout ce que le moteur de disponibilités lit pour un jour : six
 * lectures groupées, jamais une requête par créneau.
 *
 * Appelé avec le client Prisma (lecture publique, en parallèle) ou avec la
 * transaction de création (sous le verrou `Restaurant`, en série) : les mêmes
 * lectures, au même instant logique que l'écriture.
 */
export async function loadDayContext(
  db: Db,
  args: {
    restaurantId: string;
    date: string;
    now: Date;
    settings: ReservationSettings;
    pausedUntil: Date | null;
    closedOnHolidays: boolean;
    inTransaction: boolean;
  },
): Promise<DayContext> {
  const dayStart = arrivalInstant(args.date, 0);
  const dayEnd = arrivalInstant(args.date, 24 * 60);
  const [windows, spaces, occupancies, openingHours, closures, holiday] =
    await readTogether(args.inTransaction, [
      () =>
        db.reservationWindow.findMany({
          where: {
            restaurantId: args.restaurantId,
            dayOfWeek: dayOfWeekOf(args.date) as DayOfWeek,
          },
          select: { startTime: true, endTime: true },
        }),
      () =>
        db.reservationSpace.findMany({
          where: { restaurantId: args.restaurantId, archivedAt: null },
          select: {
            id: true,
            kind: true,
            minGuests: true,
            maxGuests: true,
            seatCount: true,
            maxSeatsPerBooking: true,
            position: true,
          },
        }),
      // Toute réservation active dont l'occupation peut croiser une arrivée
      // de ce jour (une arrivée à 23:59 occupe jusqu'au lendemain).
      () =>
        db.reservation.findMany({
          where: {
            restaurantId: args.restaurantId,
            status: { in: [...CAPACITY_HOLDING_STATUSES] },
            occupiedUntil: { gt: dayStart },
            arrivalAt: { lt: new Date(dayEnd.getTime() + MAX_OCCUPANCY_MS) },
          },
          select: {
            id: true,
            spaceId: true,
            partySize: true,
            arrivalAt: true,
            occupiedUntil: true,
          },
        }),
      () =>
        db.operatingHours.findMany({
          where: { restaurantId: args.restaurantId },
          select: {
            dayOfWeek: true,
            openTime: true,
            closeTime: true,
            isClosed: true,
          },
        }),
      () =>
        db.vendorClosure.findMany({
          where: {
            restaurantId: args.restaurantId,
            startsAt: { lt: dayEnd },
            endsAt: { gt: dayStart },
          },
          select: { startsAt: true, endsAt: true },
        }),
      () =>
        args.closedOnHolidays
          ? db.publicHoliday.findUnique({
              where: { date: new Date(`${args.date}T00:00:00.000Z`) },
              select: { date: true },
            })
          : Promise.resolve(null),
    ] as const);

  return {
    date: args.date,
    now: args.now,
    settings: args.settings,
    windows,
    spaces: spaces.map(
      (s): AvailabilitySpace => ({
        ...s,
        kind: s.kind as ReservationSpaceKind,
      }),
    ),
    occupancies: occupancies.map((o) => ({
      reservationId: o.id,
      spaceId: o.spaceId,
      partySize: o.partySize,
      arrivalAt: o.arrivalAt,
      occupiedUntil: o.occupiedUntil,
    })),
    openingHours,
    pausedUntil: args.pausedUntil,
    closures,
    closedForHoliday: holiday !== null,
  };
}
