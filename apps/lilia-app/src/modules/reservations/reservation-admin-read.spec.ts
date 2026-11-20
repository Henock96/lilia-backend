import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AdminReservationsQueryDto } from './dto/reservation-booking.dto';
import { arrivalInstant } from './reservation-availability';
import {
  RESERVATION_STATUSES,
  ReservationStatus,
} from './reservation-booking-vocab';
import {
  ReservationAdminService,
  toAdminListView,
} from './reservation-admin.service';
import {
  adminAllowedActions,
  ReservationRecord,
  toAdminView,
} from './reservation-records';

/** D-6 — lecture des réservations par le support. */

const NOW = new Date('2026-11-20T09:00:00Z');

function record(over: Partial<ReservationRecord> = {}): ReservationRecord {
  return {
    id: 'res_1',
    restaurantId: 'resto_1',
    userId: 'user_1',
    spaceId: 'space_1',
    status: 'CONFIRMED',
    partySize: 4,
    arrivalAt: new Date('2026-11-21T18:00:00Z'),
    endsAt: new Date('2026-11-21T20:00:00Z'),
    contactPhone: '+242061234567',
    note: 'Anniversaire',
    responseDeadlineAt: NOW,
    paymentDeadlineAt: NOW,
    acceptedAt: NOW,
    declinedAt: null,
    declineReason: null,
    expiredAt: null,
    cancelledAt: null,
    cancelReason: null,
    confirmedAt: NOW,
    honoredAt: null,
    noShowAt: null,
    indicativeSubTotal: 10_000,
    lateCancellation: false,
    createdAt: NOW,
    order: {
      id: 'order_1',
      status: 'PAYER',
      subTotal: 10_000,
      serviceFee: 1_500,
      total: 11_500,
      paymentDueAt: NOW,
    },
    space: { id: 'space_1', kind: 'TABLE', label: 'Table 4' },
    restaurant: { id: 'resto_1', nom: 'Chez Lilia', ownerId: 'owner_1' },
    user: { id: 'user_1', nom: 'Awa' },
    items: [],
    ...over,
  } as ReservationRecord;
}

describe('D-6 — gestes du support (adminAllowedActions)', () => {
  it('suit la machine d’états : annulable tant que la réservation vit', () => {
    const cancellable: ReservationStatus[] = [
      'PENDING',
      'AWAITING_PAYMENT',
      'CONFIRMED',
      'NO_SHOW',
    ];
    for (const status of RESERVATION_STATUSES) {
      expect(adminAllowedActions({ status, order: null })).toEqual(
        cancellable.includes(status) ? ['cancel'] : [],
      );
    }
  });

  it('une absence close (commande ANNULER, encaissement partagé) ne s’annule plus', () => {
    expect(
      adminAllowedActions({ status: 'NO_SHOW', order: { status: 'ANNULER' } }),
    ).toEqual([]);
    expect(
      adminAllowedActions({ status: 'NO_SHOW', order: { status: 'PAYER' } }),
    ).toEqual(['cancel']);
  });
});

describe('D-6 — projections (D6-4)', () => {
  it('la liste masque le numéro du client', () => {
    const row = toAdminListView(record());
    expect(row.customer).toEqual({
      id: 'user_1',
      nom: 'Awa',
      maskedPhone: '***67',
    });
    expect(JSON.stringify(row)).not.toContain('061234567');
    expect(row).toMatchObject({
      total: 11_500,
      orderId: 'order_1',
      spaceLabel: 'Table 4',
      allowedActions: ['cancel'],
    });
  });

  it('la liste ne renvoie ni plats, ni note, ni propriétaire', () => {
    const row = toAdminListView(record()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      [
        'allowedActions',
        'arrivalAt',
        'createdAt',
        'customer',
        'id',
        'orderId',
        'partySize',
        'restaurant',
        'spaceLabel',
        'status',
        'total',
      ].sort(),
    );
    expect(row.restaurant).toEqual({ id: 'resto_1', nom: 'Chez Lilia' });
  });

  it('le détail donne le numéro complet, sans l’identifiant du propriétaire', () => {
    const detail = toAdminView(record());
    expect(detail.customer.phone).toBe('+242061234567');
    expect(JSON.stringify(detail)).not.toContain('owner_1');
    expect(detail.payment).toMatchObject({
      total: 11_500,
      priceChanged: false,
    });
  });
});

describe('D-6 — ReservationAdminService.list / get', () => {
  function service(rows: ReservationRecord[] = [record()]) {
    const prisma = {
      reservation: {
        findMany: jest.fn().mockResolvedValue(rows),
        count: jest.fn().mockResolvedValue(rows.length),
        findUnique: jest.fn().mockResolvedValue(rows[0] ?? null),
      },
    };
    const svc = new ReservationAdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, prisma };
  }

  const query = (over: Partial<AdminReservationsQueryDto> = {}) =>
    Object.assign(new AdminReservationsQueryDto(), over);

  it('sans filtre : tous les restaurants, page demandée', async () => {
    const { svc, prisma } = service();
    const res = await svc.list(query({ page: 2, limit: 10 }));
    const args = prisma.reservation.findMany.mock.calls[0][0];
    expect(args.where).toEqual({});
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
    expect(res.meta).toEqual({ total: 1, page: 2, limit: 10 });
    expect(res.data[0].customer.maskedPhone).toBe('***67');
  });

  it('filtre par restaurant, statut et jour de Brazzaville', async () => {
    const { svc, prisma } = service();
    await svc.list(
      query({
        restaurantId: 'resto_1',
        status: 'NO_SHOW',
        date: '2026-11-21',
      }),
    );
    expect(prisma.reservation.findMany.mock.calls[0][0].where).toEqual({
      restaurantId: 'resto_1',
      status: 'NO_SHOW',
      arrivalAt: {
        gte: arrivalInstant('2026-11-21', 0),
        lt: arrivalInstant('2026-11-21', 24 * 60),
      },
    });
    expect(prisma.reservation.count.mock.calls[0][0].where).toEqual(
      prisma.reservation.findMany.mock.calls[0][0].where,
    );
  });

  it('date impossible : 400, aucune lecture', async () => {
    const { svc, prisma } = service();
    await expect(svc.list(query({ date: '2026-02-30' }))).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.reservation.findMany).not.toHaveBeenCalled();
  });

  it('détail introuvable : 404', async () => {
    const { svc } = service([]);
    await expect(svc.get('absent')).rejects.toThrow(NotFoundException);
  });
});

describe('D-6 — AdminReservationsQueryDto', () => {
  const check = (plain: object) =>
    validate(plainToInstance(AdminReservationsQueryDto, plain));

  it('accepte restaurant, statut, jour et pagination', async () => {
    expect(
      await check({
        restaurantId: 'resto_1',
        status: 'CONFIRMED',
        date: '2026-11-21',
        page: '1',
        limit: '50',
      }),
    ).toHaveLength(0);
  });

  it('refuse un statut inconnu, une date mal formée, limit > 100', async () => {
    expect(await check({ status: 'PAID' })).toHaveLength(1);
    expect(await check({ date: '21/11/2026' })).toHaveLength(1);
    expect(await check({ limit: '500' })).toHaveLength(1);
  });
});
