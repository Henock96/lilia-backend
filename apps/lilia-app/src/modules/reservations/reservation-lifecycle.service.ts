import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { RESERVATION_NOTICE_EVENT } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import { brazzavilleClock } from '../vendors/vendor-opening.policy';
import { arrivalInstant } from './reservation-availability';
import {
  BOOKING_ERROR_CODES,
  CAPACITY_HOLDING_STATUSES,
  RESERVATION_TIMINGS,
} from './reservation-booking-vocab';
import { enqueueReservationNotice } from './reservation-notices';
import { applyTransition } from './reservation-records';

const MINUTE_MS = 60_000;
/**
 * Une passe de cron traite au plus ce nombre de lignes ; le reste attend la
 * suivante. 25 et non 100 : une transaction coûte ~4 allers-retours Render →
 * Neon (~400 ms) ; 100 lignes dépasseraient le bail de 50 s du cron
 * d'expiration et deux passes se chevaucheraient (revue du 16/11).
 */
const BATCH = 25;

/**
 * Lot 4 — ce que le temps fait aux réservations, sans geste humain :
 * expiration des demandes sans réponse ou sans paiement, rappel au client,
 * récapitulatif du jour au restaurant.
 *
 * ⚠️ Exécuté par le worker (crons de `AppScheduleModule`), qui n'a aucun
 * écouteur d'événements : toute notification passe par l'outbox, dans la
 * transaction de la transition (règle 11). Rejouable : chaque écriture est
 * conditionnelle (`status`, `reminderSentAt IS NULL`, existence du
 * récapitulatif) — deux passes simultanées ne produisent rien en double.
 */
@Injectable()
export class ReservationLifecycleService {
  private readonly logger = new Logger(ReservationLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** B3 / C4 — demande sans réponse, ou acceptée mais non payée, à échéance. */
  async expireOverdue(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.reservation.findMany({
      where: {
        OR: [
          { status: 'PENDING', responseDeadlineAt: { lte: now } },
          { status: 'AWAITING_PAYMENT', paymentDeadlineAt: { lte: now } },
        ],
      },
      select: {
        id: true,
        status: true,
        userId: true,
        partySize: true,
        arrivalAt: true,
        restaurant: { select: { nom: true, ownerId: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });

    let expired = 0;
    for (const r of due) {
      const from = r.status as 'PENDING' | 'AWAITING_PAYMENT';
      try {
        await this.prisma.$transaction(async (tx) => {
          await applyTransition(tx, {
            id: r.id,
            from,
            to: 'EXPIRED',
            actor: 'SYSTEM',
            actorId: null,
            reason:
              from === 'PENDING'
                ? 'NO_VENDOR_RESPONSE'
                : 'PAYMENT_NOT_RECEIVED',
            data: { expiredAt: now },
          });
          const common = {
            notice: 'EXPIRED' as const,
            restaurantName: r.restaurant.nom,
            reservationId: r.id,
            arrivalAt: r.arrivalAt.toISOString(),
            partySize: r.partySize,
            expiredFrom: from,
          };
          await enqueueReservationNotice(tx, this.outbox, {
            ...common,
            audience: 'CLIENT',
            recipientUserId: r.userId,
          });
          // Le restaurant apprend qu'il a laissé passer une demande.
          if (from === 'PENDING') {
            await enqueueReservationNotice(tx, this.outbox, {
              ...common,
              audience: 'VENDOR',
              recipientUserId: r.restaurant.ownerId,
            });
          }
        });
        expired++;
      } catch (error) {
        // Le vendeur a répondu entre la lecture et l'écriture : rien à faire.
        // Toute autre erreur est remontée au journal, la passe continue.
        if (!isStateConflict(error)) {
          // Une ligne qui échoue à chaque passe tient sa table indéfiniment :
          // elle doit se voir ailleurs que dans un journal (revue du 16/11).
          this.logger.error(
            `Expiration de la réservation ${r.id} impossible : ${(error as Error).message}`,
            (error as Error).stack,
          );
          Sentry.captureException(error, {
            tags: { job: 'expire-reservations', reservationId: r.id },
          });
        }
      }
    }
    return expired;
  }

  /**
   * B7 — rappel 2 h avant l'arrivée, aux réservations CONFIRMÉES, sauf si la
   * confirmation est tombée moins de 3 h avant (la notification de
   * confirmation en tient lieu). Une seule fois : `reminderSentAt`.
   */
  async sendReminders(now: Date = new Date()): Promise<number> {
    const horizon = new Date(
      now.getTime() + RESERVATION_TIMINGS.reminderBeforeMin * MINUTE_MS,
    );
    const due = await this.prisma.reservation.findMany({
      where: {
        status: 'CONFIRMED',
        reminderSentAt: null,
        arrivalAt: { gt: now, lte: horizon },
      },
      select: {
        id: true,
        userId: true,
        partySize: true,
        arrivalAt: true,
        confirmedAt: true,
        restaurant: { select: { nom: true } },
      },
      take: BATCH,
    });

    let sent = 0;
    for (const r of due) {
      const lateConfirmation =
        r.confirmedAt !== null &&
        r.arrivalAt.getTime() - r.confirmedAt.getTime() <
          RESERVATION_TIMINGS.reminderMinConfirmedBeforeMin * MINUTE_MS;
      // Une ligne en échec ne prive pas les suivantes de leur rappel.
      const queued = await this.queueReminder(r, now, lateConfirmation).catch(
        (error: unknown) => this.lineFailed(`rappel ${r.id}`, error),
      );
      if (queued) sent++;
    }
    return sent;
  }

  private queueReminder(
    r: {
      id: string;
      userId: string;
      partySize: number;
      arrivalAt: Date;
      restaurant: { nom: string };
    },
    now: Date,
    lateConfirmation: boolean,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.reservation.updateMany({
        where: { id: r.id, status: 'CONFIRMED', reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      // Marqué même quand on ne l'envoie pas : la ligne ne revient plus.
      if (count !== 1 || lateConfirmation) return false;
      await enqueueReservationNotice(tx, this.outbox, {
        notice: 'REMINDER',
        audience: 'CLIENT',
        recipientUserId: r.userId,
        restaurantName: r.restaurant.nom,
        reservationId: r.id,
        arrivalAt: r.arrivalAt.toISOString(),
        partySize: r.partySize,
      });
      return true;
    });
  }

  /**
   * B7 — récapitulatif à 8 h (Brazzaville), aux restaurants qui ont au moins
   * une réservation dans la journée. Un seul par restaurant et par jour :
   * l'obligation porte `aggregateId = <restaurant>:<jour>` et n'est pas
   * réécrite si elle existe déjà (cron rejoué, deux processus).
   */
  async sendDailySummaries(now: Date = new Date()): Promise<number> {
    const { isoDate } = brazzavilleClock(now);
    const grouped = await this.prisma.reservation.groupBy({
      by: ['restaurantId'],
      where: {
        status: { in: [...CAPACITY_HOLDING_STATUSES] },
        arrivalAt: {
          gte: arrivalInstant(isoDate, 0),
          lt: arrivalInstant(isoDate, 24 * 60),
        },
      },
      _count: { _all: true },
    });
    if (grouped.length === 0) return 0;

    const restaurants = await this.prisma.restaurant.findMany({
      where: { id: { in: grouped.map((g) => g.restaurantId) } },
      select: { id: true, nom: true, ownerId: true },
    });
    const byId = new Map(restaurants.map((r) => [r.id, r]));

    let sent = 0;
    for (const g of grouped) {
      const restaurant = byId.get(g.restaurantId);
      if (!restaurant) continue;
      // Un restaurant en échec ne prive pas les suivants du récapitulatif.
      const queued = await this.queueSummary(
        restaurant,
        isoDate,
        g._count._all,
      ).catch((error: unknown) =>
        this.lineFailed(`récapitulatif ${restaurant.id}`, error),
      );
      if (queued) sent++;
    }
    return sent;
  }

  private queueSummary(
    restaurant: { id: string; nom: string; ownerId: string },
    isoDate: string,
    count: number,
  ): Promise<boolean> {
    const aggregateId = `${restaurant.id}:${isoDate}`;
    return this.prisma.$transaction(async (tx) => {
      // Lecture-puis-écriture rendue sûre sans le verrou Redis du cron (qui
      // s'exécute quand même si Redis tombe) : deux processus sur le même
      // restaurant et le même jour se sérialisent ici, le second voit la ligne.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${aggregateId}))`;
      const already = await tx.outboxEvent.findFirst({
        where: { aggregateId, type: RESERVATION_NOTICE_EVENT },
        select: { id: true },
      });
      if (already) return false;
      await enqueueReservationNotice(
        tx,
        this.outbox,
        {
          notice: 'DAILY_SUMMARY',
          audience: 'VENDOR',
          recipientUserId: restaurant.ownerId,
          restaurantName: restaurant.nom,
          date: isoDate,
          count,
        },
        aggregateId,
      );
      return true;
    });
  }

  /**
   * Une ligne d'un tour de cron a échoué : journalisée avec son identifiant
   * (le `console.error` de `cron` ne passe ni par le Logger ni par Sentry),
   * la passe continue. Rejouée au tour suivant tant que la ligne reste due.
   */
  private lineFailed(what: string, error: unknown): false {
    this.logger.error(
      `Réservations — ${what} impossible : ${(error as Error)?.message ?? String(error)}`,
    );
    return false;
  }
}

function isStateConflict(error: unknown): boolean {
  const response = (error as { getResponse?: () => unknown })?.getResponse?.();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: string }).code === BOOKING_ERROR_CODES.stateConflict
  );
}
