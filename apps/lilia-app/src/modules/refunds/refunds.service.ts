import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RefundStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Remboursements (fix H5 — audit du 28/08/2026).
 *
 * Quand une commande **déjà payée** est annulée, le système restituait stock,
 * points et code promo… et s'arrêtait là : la ligne `Payment` restait
 * `SUCCESS`, aucune entité ne matérialisait la dette envers le client, aucune
 * tâche n'apparaissait côté admin. Le `refundAmount` calculé
 * (`total >= 1000 ? total : 0`) n'alimentait qu'un message de notification,
 * appliquant une règle « non remboursable sous 1 000 XAF » qui n'était écrite
 * nulle part.
 *
 * Un `Refund` est donc ouvert automatiquement à chaque annulation post-paiement,
 * pour le montant **réellement encaissé** — pas pour une heuristique.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ouvre un remboursement pour une commande annulée après paiement.
   * Sans paiement encaissé, il n'y a rien à rembourser : on ne crée rien.
   * Idempotent (`Refund.orderId` est `@unique`).
   */
  async openForCancelledOrder(params: {
    orderId: string;
    reason: string;
    requestedBy?: string | null;
  }): Promise<{ id: string; amount: number } | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId: params.orderId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });

    // Aucun encaissement : commande expirée ou annulée avant paiement.
    if (!payment || payment.amount <= 0) return null;

    try {
      const refund = await this.prisma.refund.create({
        data: {
          orderId: params.orderId,
          paymentId: payment.id,
          amount: payment.amount,
          reason: params.reason,
          requestedBy: params.requestedBy ?? null,
          status: RefundStatus.PENDING,
        },
      });

      this.logger.warn(
        `💸 Remboursement ouvert : ${refund.amount} XAF sur la commande ${params.orderId} (${params.reason})`,
      );
      return { id: refund.id, amount: refund.amount };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Déjà ouvert : annulation rejouée.
        const existing = await this.prisma.refund.findUnique({
          where: { orderId: params.orderId },
        });
        return existing ? { id: existing.id, amount: existing.amount } : null;
      }
      throw error;
    }
  }

  /** File de traitement admin, la plus ancienne d'abord. */
  async list(params: { status?: RefundStatus; page?: number; limit?: number }) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const where: Prisma.RefundWhereInput = params.status
      ? { status: params.status }
      : {};

    const [refunds, total] = await Promise.all([
      this.prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          order: {
            select: {
              id: true,
              total: true,
              status: true,
              paymentMethod: true,
              contactPhone: true,
              user: { select: { id: true, nom: true, phone: true } },
              restaurant: { select: { id: true, nom: true } },
            },
          },
        },
      }),
      this.prisma.refund.count({ where }),
    ]);

    return { data: refunds, meta: { page, limit, total } };
  }

  async findOne(id: string) {
    const refund = await this.prisma.refund.findUnique({
      where: { id },
      include: { order: true, payment: true },
    });
    if (!refund) throw new NotFoundException('Remboursement introuvable.');
    return { data: refund };
  }

  /**
   * Fait avancer un remboursement. Le passage à `COMPLETED` ou `REJECTED` est
   * conditionné sur le statut lu : deux admins qui traitent la même ligne en
   * même temps ne peuvent pas la clôturer deux fois.
   */
  async updateStatus(
    id: string,
    status: RefundStatus,
    adminId: string,
    notes?: string,
  ) {
    const refund = await this.prisma.refund.findUnique({ where: { id } });
    if (!refund) throw new NotFoundException('Remboursement introuvable.');

    if (
      refund.status === RefundStatus.COMPLETED ||
      refund.status === RefundStatus.REJECTED
    ) {
      throw new ConflictException(
        `Ce remboursement est déjà clos (${refund.status}).`,
      );
    }

    const isFinal =
      status === RefundStatus.COMPLETED || status === RefundStatus.REJECTED;

    const claimed = await this.prisma.refund.updateMany({
      where: { id, status: refund.status },
      data: {
        status,
        notes: notes ?? refund.notes,
        processedBy: adminId,
        processedAt: isFinal ? new Date() : refund.processedAt,
      },
    });

    if (claimed.count === 0) {
      throw new ConflictException(
        'Ce remboursement a été modifié entre-temps. Rechargez la fiche.',
      );
    }

    return this.findOne(id);
  }
}
