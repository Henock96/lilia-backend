import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RefundReasonCode, RefundStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AUTO_REFUND_REASON_CODES,
  COUNTED_REFUND_STATUSES,
  refundConflictsWithPayout,
} from './refund-lines.policy';
import { recordClawbackIfDue } from '../payments/vendor-balance';

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
   *
   * Idempotent : un seul remboursement « total automatique » par commande
   * (index partiel `Refund_orderId_auto_uq`, F3-06). Rejouer l'annulation —
   * l'outbox le fait par construction — rend la ligne existante, même
   * `COMPLETED`, au lieu d'en ouvrir une seconde.
   *
   * Le montant est ce qui reste dû : l'encaissement, moins d'éventuels
   * remboursements partiels déjà comptés.
   */
  async openForCancelledOrder(params: {
    orderId: string;
    reason: string;
    requestedBy?: string | null;
    reasonCode?: RefundReasonCode;
  }): Promise<{ id: string; amount: number } | null> {
    const existing = await this.findAutomaticRefund(params.orderId);
    if (existing) return existing;

    const payment = await this.prisma.payment.findFirst({
      where: { orderId: params.orderId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });

    // Aucun encaissement : commande expirée ou annulée avant paiement.
    if (!payment || payment.amount <= 0) return null;

    const refunded = await this.prisma.refund.aggregate({
      where: {
        orderId: params.orderId,
        status: { in: COUNTED_REFUND_STATUSES },
      },
      _sum: { amount: true },
    });
    const amount = payment.amount - (refunded._sum.amount ?? 0);
    if (amount <= 0) return null;

    try {
      const refund = await this.prisma.refund.create({
        data: {
          orderId: params.orderId,
          paymentId: payment.id,
          amount,
          reason: params.reason,
          reasonCode: params.reasonCode ?? RefundReasonCode.ORDER_CANCELLED,
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
        // Déjà ouvert : annulation rejouée en concurrence. (Un P2002 sur
        // l'index « en vol » — un remboursement partiel non soldé — remonte :
        // l'outbox rejouera une fois ce dernier traité.)
        const replayed = await this.findAutomaticRefund(params.orderId);
        if (replayed) return replayed;
      }
      throw error;
    }
  }

  private async findAutomaticRefund(
    orderId: string,
  ): Promise<{ id: string; amount: number } | null> {
    const found = await this.prisma.refund.findFirst({
      where: { orderId, reasonCode: { in: AUTO_REFUND_REASON_CODES } },
      select: { id: true, amount: true },
    });
    return found ?? null;
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
          lines: {
            include: {
              orderItem: {
                select: { variant: true, product: { select: { nom: true } } },
              },
            },
          },
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
      include: { order: true, payment: true, lines: true },
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

    // Fix F-04 — clôturer « remboursé » à la main pendant qu'un reversement
    // vendeur est en vol reproduirait la double sortie que l'exécution
    // automatique refuse. Un reversement déjà `SUCCESS` reste clôturable à la
    // main : c'est précisément l'issue d'un arbitrage (Lilia rembourse à sa
    // charge), tracée dans le journal d'audit par le contrôleur.
    if (
      (status === RefundStatus.COMPLETED ||
        status === RefundStatus.PROCESSING) &&
      refundConflictsWithPayout(refund)
    ) {
      const payout = await this.prisma.restaurantPayout.findUnique({
        where: { orderId: refund.orderId },
        select: { status: true },
      });
      if (payout?.status === 'PENDING') {
        throw new ConflictException(
          'Un reversement au vendeur est en cours pour cette commande. Attendez son issue avant de clôturer le remboursement.',
        );
      }
    }
    const isFinal =
      status === RefundStatus.COMPLETED || status === RefundStatus.REJECTED;

    // F3-07 — clôturer « remboursé » un remboursement à la charge d'un vendeur
    // déjà payé fait naître sa dette : même transaction.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.refund.updateMany({
        where: { id, status: refund.status },
        data: {
          status,
          notes: notes ?? refund.notes,
          processedBy: adminId,
          processedAt: isFinal ? new Date() : refund.processedAt,
        },
      });
      if (moved.count > 0 && status === RefundStatus.COMPLETED) {
        await recordClawbackIfDue(tx, refund);
      }
      return moved;
    });

    if (claimed.count === 0) {
      throw new ConflictException(
        'Ce remboursement a été modifié entre-temps. Rechargez la fiche.',
      );
    }

    return this.findOne(id);
  }
}
