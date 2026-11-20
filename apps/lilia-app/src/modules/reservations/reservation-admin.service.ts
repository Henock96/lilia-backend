import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminAuditAction } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { ReservationStatus } from './reservation-booking-vocab';
import { enqueueReservationNotice } from './reservation-notices';
import { ReservationOrderRelease } from './reservation-order-release';
import { applyTransition } from './reservation-records';
import { assertReservationTransition } from './reservation-state.machine';

/**
 * 4B-2 J6 (I-10, 19/11) — le support annule une réservation.
 *
 * Depuis J5, l'ADMIN ne pilote plus une commande liée par les routes de
 * commande (OD-20) : « les annulations administratives passent par le
 * parcours réservation » (relevé du 21/10). Même effet qu'une annulation par
 * le restaurant — réservation `CANCELLED_BY_VENDOR` (acteur `ADMIN`, motif
 * libre au journal), commande liée libérée ou annulée, stock rendu — à une
 * différence près : le remboursement d'une réservation payée part par la
 * **file admin** (quatre yeux au-delà du seuil), pas par le chemin
 * automatique de la faute vendeur. L'annulation elle-même ne fait partir
 * aucun argent.
 *
 * Une absence déjà close (12 h, encaissement partagé) ne s'annule plus ici :
 * un geste commercial passe par les remboursements existants.
 */
@Injectable()
export class ReservationAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly release: ReservationOrderRelease,
    private readonly audit: AdminAuditService,
  ) {}

  async cancel(
    adminUserId: string,
    id: string,
    reason: string,
    now: Date = new Date(),
  ) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const r = await tx.reservation.findUnique({
        where: { id },
        select: {
          status: true,
          userId: true,
          partySize: true,
          arrivalAt: true,
          restaurant: { select: { nom: true, ownerId: true } },
        },
      });
      if (!r) throw new NotFoundException('Réservation introuvable.');
      const from = r.status as ReservationStatus;
      assertReservationTransition(from, 'CANCELLED_BY_VENDOR', 'ADMIN');

      // La commande avant la réservation (ordre des verrous du paiement).
      const linked =
        from === 'AWAITING_PAYMENT' ? await this.release.lock(tx, id) : null;
      this.release.assertNoPaymentInProgress(linked);
      const paid =
        from === 'CONFIRMED' || from === 'NO_SHOW'
          ? await this.release.lockPaid(tx, id)
          : null;

      await applyTransition(tx, {
        id,
        from,
        to: 'CANCELLED_BY_VENDOR',
        actor: 'ADMIN',
        actorId: adminUserId,
        reason,
        data: {
          cancelledAt: now,
          cancelReason: 'OTHER',
          // CHECK `Reservation_noShow_check` : `noShowAt` n'existe qu'en
          // NO_SHOW. L'absence reste au journal (`ReservationEvent`).
          ...(from === 'NO_SHOW' ? { noShowAt: null } : {}),
        },
      });
      const orderReason = `Réservation annulée par le support : ${reason}`;
      if (linked) {
        await this.release.release(tx, linked, {
          actor: 'ADMIN',
          actorUserId: adminUserId,
          source: 'ADMIN_APP',
          reason: orderReason,
        });
      }
      if (paid) {
        const refundDue = await this.release.cancelPaid(tx, paid, {
          actor: 'ADMIN',
          actorUserId: adminUserId,
          reason: orderReason,
          requestedBy: adminUserId,
          vendorFault: false,
          source: 'ADMIN_APP',
        });
        await this.outbox.enqueueInTransaction(tx, refundDue);
      }

      const common = {
        notice: 'CANCELLED_BY_ADMIN' as const,
        restaurantName: r.restaurant.nom,
        reservationId: id,
        arrivalAt: r.arrivalAt.toISOString(),
        partySize: r.partySize,
        ...(paid ? { refundXaf: paid.total } : {}),
      };
      await enqueueReservationNotice(tx, this.outbox, {
        ...common,
        audience: 'CLIENT',
        recipientUserId: r.userId,
      });
      await enqueueReservationNotice(tx, this.outbox, {
        ...common,
        audience: 'VENDOR',
        recipientUserId: r.restaurant.ownerId,
      });
      return {
        from,
        orderId: linked?.id ?? paid?.id ?? null,
        refundXaf: paid?.total ?? null,
      };
    });

    // Journal d'audit admin (jamais bloquant) : le geste force l'état de la
    // commande liée. Sans commande, le journal de la réservation suffit.
    if (outcome.orderId) {
      await this.audit.record({
        actorId: adminUserId,
        action: AdminAuditAction.ORDER_STATUS_FORCED,
        targetType: 'Order',
        targetId: outcome.orderId,
        reason,
        metadata: {
          reservationId: id,
          reservationFrom: outcome.from,
          refundXaf: outcome.refundXaf,
        },
      });
    }
    return {
      id,
      status: 'CANCELLED_BY_VENDOR' as const,
      refundXaf: outcome.refundXaf,
    };
  }
}
