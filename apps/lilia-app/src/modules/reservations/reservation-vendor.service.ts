import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  DeclineReservationDto,
  VendorCancelReservationDto,
  VendorReservationsQueryDto,
} from './dto/reservation-booking.dto';
import {
  arrivalInstant,
  AvailabilitySpace,
  fitsParty,
  isSpaceFree,
  parseIsoDate,
  paymentDeadline,
} from './reservation-availability';
import { lockRestaurant } from './reservation-booking.service';
import { ReservationOrderRelease } from './reservation-order-release';
import { ReservationOrderService } from './reservation-order.service';
import {
  BOOKING_ERROR_CODES as CODES,
  CAPACITY_HOLDING_STATUSES,
  ReservationStatus,
} from './reservation-booking-vocab';
import {
  enqueueReservationNotice,
  ReservationNotice,
} from './reservation-notices';
import {
  applyTransition,
  RESERVATION_RECORD_SELECT,
  ReservationRecord,
  stateConflict,
  toVendorView,
  VendorAction,
  vendorAllowedActions,
} from './reservation-records';
import { ReservationSpaceKind } from './reservation-vocab';

type Db = Prisma.TransactionClient;

/**
 * Lot 4 (4B-1) — les réservations vues du restaurant.
 *
 * - Le restaurant est **toujours** celui du compte connecté (`ownerId`) ; une
 *   réservation d'un autre restaurant répond 404, comme une réservation
 *   inexistante (règle 18 bis).
 * - Chaque geste n'est permis que s'il figure dans `allowedActions` — machine
 *   d'états et règles de temps, une seule définition (`reservation-records`).
 * - La gestion de l'existant ne dépend pas du Premium (C7) : un abonnement
 *   échu n'empêche ni d'honorer ni de répondre aux demandes déjà reçues.
 * - Toute notification part par l'outbox, dans la transaction (règle 11).
 */
@Injectable()
export class ReservationVendorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly linkedOrders: ReservationOrderService,
    private readonly release: ReservationOrderRelease,
  ) {}

  async list(
    ownerId: string,
    query: VendorReservationsQueryDto,
    now: Date = new Date(),
  ) {
    // Revue sécurité L1 : le DTO ne vérifie que la forme ; « 2026-02-30 »
    // ferait lever `arrivalInstant` (500). Même 400 que côté client.
    if (query.date !== undefined && !parseIsoDate(query.date)) {
      throw new BadRequestException({
        message: 'Date invalide.',
        code: CODES.invalidDate,
      });
    }
    const vendor = await this.resolveVendor(ownerId);
    const where: Prisma.ReservationWhereInput = {
      restaurantId: vendor.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.date
        ? {
            arrivalAt: {
              gte: arrivalInstant(query.date, 0),
              lt: arrivalInstant(query.date, 24 * 60),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.reservation.findMany({
        where,
        select: RESERVATION_RECORD_SELECT,
        orderBy: [{ arrivalAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.reservation.count({ where }),
    ]);
    return {
      data: rows.map((r) => toVendorView(r, now)),
      meta: { total, page: query.page, limit: query.limit },
    };
  }

  async get(ownerId: string, id: string, now: Date = new Date()) {
    const vendor = await this.resolveVendor(ownerId);
    return toVendorView(await this.findOwned(this.prisma, vendor.id, id), now);
  }

  /**
   * Le restaurant accepte : la table est tenue 15 min pour le paiement (C4),
   * jamais au-delà de l'arrivée − 10 min (OD-02).
   *
   * 4B-2 (OD-03) — l'acceptation crée la commande liée, au montant réel :
   * plats relus et chiffrés **avant** la transaction (un plat indisponible ⇒
   * 409 nominatif, rien d'écrit), puis transition, commande, stock et avis
   * dans une seule transaction. Deux acceptations simultanées : la seconde
   * trouve la réservation déjà `AWAITING_PAYMENT` (409), et l'index unique
   * `Order.reservationId` tient en dernier recours.
   */
  async accept(ownerId: string, id: string, now: Date = new Date()) {
    const vendor = await this.resolveVendor(ownerId);
    const read = await this.findOwned(this.prisma, vendor.id, id);
    assertAllowed(read, now, 'accept');
    const prepared = await this.linkedOrders.prepare(read, now);
    const paymentDeadlineAt = paymentDeadline(now, read.arrivalAt);
    await this.prisma.$transaction(async (tx) => {
      const r = await this.findOwned(tx, vendor.id, id);
      assertAllowed(r, now, 'accept');
      await applyTransition(tx, {
        id,
        from: r.status as ReservationStatus,
        to: 'AWAITING_PAYMENT',
        actor: 'RESTAURATEUR',
        actorId: ownerId,
        data: { acceptedAt: now, paymentDeadlineAt },
      });
      const { total } = await this.linkedOrders.createInTransaction(
        tx,
        r,
        prepared,
        { now, paymentDueAt: paymentDeadlineAt, acceptedBy: ownerId },
      );
      await enqueueReservationNotice(tx, this.outbox, {
        notice: 'ACCEPTED',
        audience: 'CLIENT',
        recipientUserId: r.userId,
        restaurantName: r.restaurant.nom,
        reservationId: id,
        arrivalAt: r.arrivalAt.toISOString(),
        partySize: r.partySize,
        paymentDeadlineAt: paymentDeadlineAt.toISOString(),
        totalXaf: total,
        priceChanged:
          r.indicativeSubTotal !== null &&
          r.indicativeSubTotal !== prepared.amounts.subTotal,
      });
    });
    return this.get(ownerId, id, now);
  }

  decline(
    ownerId: string,
    id: string,
    dto: DeclineReservationDto,
    now: Date = new Date(),
  ) {
    return this.act(ownerId, id, now, 'decline', () => ({
      to: 'DECLINED',
      data: { declinedAt: now, declineReason: dto.reason },
      reason: dto.reason,
      notice: 'DECLINED',
    }));
  }

  /**
   * Non payée : la commande liée est libérée. Payée (J5) : elle est annulée
   * et le client remboursé intégralement, comme un refus du restaurant.
   */
  cancel(
    ownerId: string,
    id: string,
    dto: VendorCancelReservationDto,
    now: Date = new Date(),
  ) {
    return this.act(ownerId, id, now, 'cancel', () => ({
      to: 'CANCELLED_BY_VENDOR',
      data: { cancelledAt: now, cancelReason: dto.reason },
      reason: dto.reason,
      notice: 'CANCELLED_BY_VENDOR',
    }));
  }

  /**
   * B2 — absence déclarée de l'arrivée + 15 min à la fin du jour d'arrivée.
   * La compensation du restaurant (C3, D1) arrive avec 4B-2.
   */
  markNoShow(ownerId: string, id: string, now: Date = new Date()) {
    return this.act(ownerId, id, now, 'noShow', () => ({
      to: 'NO_SHOW',
      data: { noShowAt: now },
      notice: 'NO_SHOW',
    }));
  }

  /**
   * B2 — une absence déclarée par erreur se retire pendant 6 h (révisé le
   * 19/11) ; après 12 h, elle est close (J6, partage de l'encaissement).
   *
   * ⚠️ NO_SHOW ne tient pas de capacité : entre le marquage et le retrait, la
   * table a pu être redonnée à un autre client pour un créneau qui chevauche
   * encore l'occupation figée. Repasser en CONFIRMED **reprend** donc de la
   * capacité : sous le verrou `Restaurant`, et seulement si la table est
   * toujours libre (revue base de données du 18/10, C1). Sinon 409, rien
   * d'écrit.
   */
  undoNoShow(ownerId: string, id: string, now: Date = new Date()) {
    return this.act(
      ownerId,
      id,
      now,
      'undoNoShow',
      () => ({
        to: 'CONFIRMED',
        data: { noShowAt: null },
        notice: 'NO_SHOW_UNDONE',
      }),
      { reclaimsCapacity: true },
    );
  }

  /**
   * Q10/B5 — le restaurant déplace une réservation vers une autre ressource
   * **du même type**, libre sur toute l'occupation déjà figée ; le client en
   * est prévenu, avec le nom de sa nouvelle table (C5). Sous le verrou
   * `Restaurant`, comme toute écriture qui consomme de la capacité.
   */
  async reassign(
    ownerId: string,
    id: string,
    spaceId: string,
    now: Date = new Date(),
  ) {
    const vendor = await this.resolveVendor(ownerId);
    await this.prisma.$transaction(async (tx) => {
      await lockRestaurant(tx, vendor.id);
      const r = await this.findOwned(tx, vendor.id, id);
      assertAllowed(r, now, 'reassign');

      // En série : une transaction tient une seule connexion.
      const target = await tx.reservationSpace.findFirst({
        where: { id: spaceId, restaurantId: vendor.id, archivedAt: null },
        select: SPACE_CAPACITY_SELECT,
      });
      const frozen = await tx.reservation.findUniqueOrThrow({
        where: { id },
        select: { occupiedUntil: true },
      });
      const space = target
        ? { ...target, kind: target.kind as ReservationSpaceKind }
        : null;
      if (
        !space ||
        space.id === r.spaceId ||
        space.kind !== r.space.kind ||
        !fitsParty(space, r.partySize)
      ) {
        throw incompatibleSpace();
      }
      if (!(await spaceFreeFor(tx, space, r, frozen.occupiedUntil))) {
        throw incompatibleSpace();
      }

      const { count } = await tx.reservation.updateMany({
        where: { id, status: r.status, spaceId: r.spaceId },
        data: { spaceId: space.id },
      });
      if (count !== 1) throw stateConflict(r.status);
      await tx.reservationEvent.create({
        data: {
          reservationId: id,
          fromStatus: r.status,
          toStatus: r.status,
          actorRole: 'RESTAURATEUR',
          actorId: ownerId,
          reason: 'REASSIGNED',
          fromSpaceId: r.spaceId,
          toSpaceId: space.id,
        },
      });
      await enqueueReservationNotice(tx, this.outbox, {
        notice: 'REASSIGNED',
        audience: 'CLIENT',
        recipientUserId: r.userId,
        restaurantName: r.restaurant.nom,
        reservationId: id,
        arrivalAt: r.arrivalAt.toISOString(),
        partySize: r.partySize,
        spaceLabel: space.label,
      });
    });
    return this.get(ownerId, id, now);
  }

  /**
   * Un geste du restaurant : verdict `allowedActions`, transition
   * conditionnelle, journal et notification au client — une transaction.
   */
  private async act(
    ownerId: string,
    id: string,
    now: Date,
    action: VendorAction,
    plan: (r: ReservationRecord) => {
      to: ReservationStatus;
      data: Prisma.ReservationUpdateManyMutationInput;
      notice: ReservationNotice;
      reason?: string;
    },
    options: { reclaimsCapacity?: boolean } = {},
  ) {
    const vendor = await this.resolveVendor(ownerId);
    await this.prisma.$transaction(async (tx) => {
      // Un geste qui reprend de la capacité se sérialise avec les créations
      // et réattributions, sous le même verrou (03 §6).
      if (options.reclaimsCapacity) await lockRestaurant(tx, vendor.id);
      const r = await this.findOwned(tx, vendor.id, id);
      assertAllowed(r, now, action);
      // 4B-2 — annuler une réservation acceptée emporte sa commande liée ;
      // la commande se verrouille avant la réservation (ordre du paiement).
      const linked =
        action === 'cancel' && r.status === 'AWAITING_PAYMENT'
          ? await this.release.lock(tx, id)
          : null;
      this.release.assertNoPaymentInProgress(linked);
      // J5 — payée : la commande suit, remboursement intégral, faute du
      // restaurant (chemin automatique existant).
      const paid =
        action === 'cancel' && r.status === 'CONFIRMED'
          ? await this.release.lockPaid(tx, id)
          : null;
      if (options.reclaimsCapacity) {
        const [space, frozen] = [
          await tx.reservationSpace.findUniqueOrThrow({
            where: { id: r.spaceId },
            select: SPACE_CAPACITY_SELECT,
          }),
          await tx.reservation.findUniqueOrThrow({
            where: { id },
            select: { occupiedUntil: true },
          }),
        ];
        const free = await spaceFreeFor(
          tx,
          { ...space, kind: space.kind as ReservationSpaceKind },
          r,
          frozen.occupiedUntil,
        );
        if (!free) {
          throw new ConflictException({
            message:
              'La table a été redonnée entre-temps à un autre client : l’absence ne peut plus être retirée. Contactez le support.',
            code: CODES.capacityTaken,
          });
        }
      }
      const step = plan(r);
      await applyTransition(tx, {
        id,
        from: r.status as ReservationStatus,
        to: step.to,
        actor: 'RESTAURATEUR',
        actorId: ownerId,
        reason: step.reason,
        data: step.data,
      });
      if (linked) {
        await this.release.release(tx, linked, {
          actor: 'RESTAURATEUR',
          actorUserId: ownerId,
          source: 'APP',
          reason: 'Réservation annulée par le restaurant avant paiement',
        });
      }
      if (paid) {
        const refundDue = await this.release.cancelPaid(tx, paid, {
          actor: 'RESTAURATEUR',
          actorUserId: ownerId,
          reason: 'Réservation payée annulée par le restaurant',
          requestedBy: ownerId,
          vendorFault: true,
        });
        await this.outbox.enqueueInTransaction(tx, refundDue);
      }
      await enqueueReservationNotice(tx, this.outbox, {
        notice: step.notice,
        audience: 'CLIENT',
        recipientUserId: r.userId,
        restaurantName: r.restaurant.nom,
        reservationId: id,
        arrivalAt: r.arrivalAt.toISOString(),
        partySize: r.partySize,
        ...(paid ? { refundXaf: paid.total } : {}),
        ...(step.notice === 'NO_SHOW' && r.order ? { paidPreorder: true } : {}),
      });
    });
    return this.get(ownerId, id, now);
  }

  /** Le restaurant du compte connecté — jamais un identifiant de la requête. */
  private async resolveVendor(ownerId: string) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      select: { id: true },
    });
    if (!vendor) {
      throw new ForbiddenException('Vous devez posséder un vendeur.');
    }
    return vendor;
  }

  private async findOwned(
    db: Db,
    restaurantId: string,
    id: string,
  ): Promise<ReservationRecord> {
    const r = await db.reservation.findFirst({
      where: { id, restaurantId },
      select: RESERVATION_RECORD_SELECT,
    });
    if (!r) throw new NotFoundException('Réservation introuvable.');
    return r;
  }
}

function assertAllowed(
  r: ReservationRecord,
  now: Date,
  action: VendorAction,
): void {
  if (vendorAllowedActions(r, now).includes(action)) return;
  if (action === 'noShow' && r.status === 'CONFIRMED') {
    throw new ConflictException({
      message:
        'Une absence se déclare au plus tôt 15 minutes après l’heure d’arrivée, et le jour même.',
      code: CODES.noShowTooEarly,
    });
  }
  throw new ConflictException({
    message:
      'Cette action n’est pas possible sur cette réservation dans son état actuel.',
    code: CODES.actionUnavailable,
    status: r.status,
  });
}

/** Ce que le contrôle de capacité lit d'une ressource. */
const SPACE_CAPACITY_SELECT = {
  id: true,
  kind: true,
  label: true,
  minGuests: true,
  maxGuests: true,
  seatCount: true,
  maxSeatsPerBooking: true,
  position: true,
} as const satisfies Prisma.ReservationSpaceSelect;

/**
 * La ressource peut-elle tenir cette réservation sur son occupation figée
 * `[arrivée, occupiedUntil)`, sans compter la réservation elle-même ? À
 * appeler sous le verrou `Restaurant` (réattribution, retrait d'absence).
 */
async function spaceFreeFor(
  tx: Db,
  space: AvailabilitySpace,
  r: Pick<ReservationRecord, 'id' | 'partySize' | 'arrivalAt'>,
  occupiedUntil: Date,
): Promise<boolean> {
  const occupancies = await tx.reservation.findMany({
    where: {
      spaceId: space.id,
      status: { in: [...CAPACITY_HOLDING_STATUSES] },
      arrivalAt: { lt: occupiedUntil },
      occupiedUntil: { gt: r.arrivalAt },
    },
    select: {
      id: true,
      spaceId: true,
      partySize: true,
      arrivalAt: true,
      occupiedUntil: true,
    },
  });
  return isSpaceFree(
    space,
    r.partySize,
    r.arrivalAt,
    occupiedUntil,
    occupancies.map((o) => ({ ...o, reservationId: o.id })),
    r.id,
  );
}

function incompatibleSpace(): BadRequestException {
  return new BadRequestException({
    message:
      'Cette table ne convient pas : elle doit être du même type, accueillir le groupe et être libre sur toute la durée.',
    code: CODES.spaceIncompatible,
  });
}
