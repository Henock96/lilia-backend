import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { User } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PaymentService } from '../payments/services/payment.service';
import { PayReservationDto } from './dto/reservation-booking.dto';
import { BOOKING_ERROR_CODES as CODES } from './reservation-booking-vocab';

/**
 * Lot 4 (4B-2) — le client paie sa précommande acceptée.
 *
 * Une façade, pas un second chemin d'argent : après les contrôles propres à
 * la réservation, l'encaissement est celui de toute commande
 * (`PaymentService.createPayment`, **inchangé** — propriété, articles encore
 * disponibles, plafond de tentatives, une seule tentative `PENDING`, échéance
 * `paymentDueAt` du parcours `ACCEPT_FIRST`, identifiant prestataire persisté
 * avant l'appel). Le montant est celui de la commande liée, jamais du corps.
 * La réservation n'est confirmée que par le verdict du prestataire (règle 3),
 * dans la transaction qui fait passer la commande à `PAYER`.
 */
@Injectable()
export class ReservationPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
  ) {}

  async pay(
    user: Pick<User, 'id' | 'firebaseUid'>,
    id: string,
    dto: PayReservationDto,
    clientFlow: string | undefined,
    now: Date = new Date(),
  ) {
    const r = await this.prisma.reservation.findFirst({
      where: { id, userId: user.id },
      select: {
        status: true,
        paymentDeadlineAt: true,
        order: { select: { id: true, status: true, total: true } },
      },
    });
    if (!r) throw new NotFoundException('Réservation introuvable.');
    if (
      r.status !== 'AWAITING_PAYMENT' ||
      !r.order ||
      r.order.status !== 'EN_ATTENTE' ||
      !r.paymentDeadlineAt ||
      now >= r.paymentDeadlineAt
    ) {
      throw new ConflictException({
        message:
          'Cette réservation ne se paie pas maintenant : le restaurant doit l’avoir acceptée, et le délai de paiement ne doit pas être dépassé.',
        code: CODES.paymentClosed,
        status: r.status,
      });
    }
    if (dto.expectedTotal !== r.order.total) {
      throw new ConflictException({
        message:
          'Le montant de votre précommande a changé. Vérifiez le nouveau total avant de payer.',
        code: CODES.totalChanged,
        total: r.order.total,
      });
    }
    // L'opérateur choisi est porté par la tentative (`Payment.method`) ;
    // `Order.paymentMethod` garde la valeur posée à l'acceptation, comme une
    // commande ordinaire payée avec un autre opérateur (défaut préexistant du
    // reçu, noté au backlog). Le statut de la commande n'est écrit que par
    // `OrderTransitionService` (`order-status-write-sites.spec.ts`).
    return this.payments.createPayment(
      { orderId: r.order.id, phoneNumber: dto.phoneNumber, method: dto.method },
      user.firebaseUid,
      clientFlow,
    );
  }
}
