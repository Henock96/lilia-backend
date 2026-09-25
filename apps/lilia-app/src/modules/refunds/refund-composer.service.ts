import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  IncidentStatus,
  MessageVisibility,
  OrderStatus,
  Prisma,
  RefundBearer,
  RefundStatus,
  Role,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { lockOrderRow } from '../orders/order-row-lock';
import { ComposeRefundDto } from './dto/compose-refund.dto';
import { RefundExecutionService } from './refund-execution.service';
import {
  COUNTED_REFUND_STATUSES,
  composeRefund,
  defaultBearer,
  IN_FLIGHT_REFUND_STATUSES,
  RefundComposition,
  RefundCompositionError,
  RefundableOrder,
} from './refund-lines.policy';

/** Payload de `claim.resolved` — écouté par les notifications (web seulement). */
export interface ClaimResolvedEvent {
  incidentId: string;
  orderId: string;
  userId: string;
  restaurantId: string;
  outcome: 'REFUNDED' | 'VOUCHER' | 'REJECTED';
  amountXaf: number;
  bearer?: RefundBearer;
}
export const CLAIM_RESOLVED_EVENT = 'claim.resolved';

/** Une commande se rembourse partiellement une fois terminée, pas avant. */
const REFUNDABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.LIVRER,
  OrderStatus.ECHEC_LIVRAISON,
];

const fmt = (n: number) => `${n.toLocaleString('fr-FR')} FCFA`;

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Composeur de remboursement (F3-06) — `POST /admin/orders/:id/refunds`.
 *
 * L'administrateur coche des articles, des frais, un geste ; le **serveur**
 * calcule le montant (`composeRefund`), l'aperçu et l'écriture passant par la
 * même fonction. Rien n'est jamais repris d'un total envoyé par le front.
 *
 * L'écriture se fait sous le verrou de la commande (`lockOrderRow`), le même
 * que prennent le reversement vendeur et l'exécution d'un remboursement :
 * deux administrateurs qui remboursent la même commande en même temps sont
 * sérialisés, et le second relit ce que le premier a remboursé (R-06.2).
 * L'index partiel `Refund_orderId_inflight_uq` tient la même règle en base.
 */
@Injectable()
export class RefundComposerService {
  private readonly logger = new Logger(RefundComposerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly execution: RefundExecutionService,
    private readonly events: EventEmitter2,
  ) {}

  /** Aperçu : rien n'est écrit. Des lignes vides rendent l'état remboursable. */
  async quote(orderId: string, dto: Partial<ComposeRefundDto>) {
    const loaded = await this.load(this.prisma, orderId);
    const composition = this.compose(loaded, dto.lines ?? [], true);
    const suggested = dto.reasonCode
      ? defaultBearer(dto.reasonCode, loaded.order.failureLiability)
      : null;
    const bearer = dto.bearer ?? suggested;
    return {
      ...composition,
      suggestedBearer: suggested,
      inFlight: loaded.inFlight,
      // R-06.5 — dit AVANT le clic ce que l'écriture refusera.
      blockedReason:
        bearer === RefundBearer.VENDOR
          ? vendorBlock(loaded.payoutStatus)
          : null,
    };
  }

  async create(orderId: string, dto: ComposeRefundDto, adminId: string) {
    const bearer =
      dto.bearer ??
      defaultBearer(
        dto.reasonCode,
        (
          await this.prisma.order.findUnique({
            where: { id: orderId },
            select: { failureLiability: true },
          })
        )?.failureLiability ?? null,
      );

    let created: {
      refundId: string;
      composition: RefundComposition;
      order: { userId: string; restaurantId: string };
      closedIncidentId: string | null;
    };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const locked = await lockOrderRow(tx, orderId);
        if (!locked) throw new NotFoundException('Commande introuvable.');
        const loaded = await this.load(tx, orderId);

        if (loaded.inFlight) {
          throw new ConflictException({
            message:
              'Un remboursement est déjà en cours sur cette commande. Attendez son issue avant d’en ouvrir un autre.',
            code: 'REFUND_IN_FLIGHT',
          });
        }
        if (bearer === RefundBearer.VENDOR) {
          const blocked = vendorBlock(loaded.payoutStatus);
          if (blocked) {
            throw new ConflictException({
              message: blocked,
              code: 'VENDOR_ALREADY_PAID',
            });
          }
        }

        const composition = this.compose(loaded, dto.lines, false);

        let incidentId: string | null = null;
        if (dto.incidentId) {
          const incident = await tx.incident.findUnique({
            where: { id: dto.incidentId },
            select: { id: true, orderId: true },
          });
          if (!incident || incident.orderId !== orderId) {
            throw new BadRequestException(
              'Cette réclamation ne porte pas sur cette commande.',
            );
          }
          incidentId = incident.id;
        }

        const refund = await tx.refund.create({
          data: {
            orderId,
            paymentId: loaded.paymentId,
            amount: composition.totalXaf,
            reason:
              dto.note?.trim() ||
              composition.lines.map((l) => l.label).join(', '),
            reasonCode: dto.reasonCode,
            bearer,
            incidentId,
            requestedBy: adminId,
            status: RefundStatus.PENDING,
            lines: {
              create: composition.lines.map((l) => ({
                kind: l.kind,
                orderItemId: l.orderItemId,
                quantity: l.quantity,
                amountXaf: l.amountXaf,
              })),
            },
          },
          select: { id: true },
        });

        // La réclamation est close avec son issue, dans la même transaction :
        // le client ne voit jamais « en cours » une demande déjà remboursée.
        let closedIncidentId: string | null = null;
        if (incidentId) {
          await closeClaim(tx, {
            incidentId,
            adminId,
            outcome: 'REFUNDED',
            resolution: `${fmt(composition.totalXaf)} remboursés (${composition.lines
              .map((l) => l.label)
              .join(', ')}).`,
            clientMessage:
              `Nous vous remboursons ${fmt(composition.totalXaf)} ` +
              `(${composition.lines.map((l) => l.label).join(', ')}). ` +
              'Le virement part sur le numéro Mobile Money qui a payé la commande.',
            extraMetadata: { refundId: refund.id, bearer },
          });
          closedIncidentId = incidentId;
        }

        return {
          refundId: refund.id,
          composition,
          order: {
            userId: loaded.order.userId,
            restaurantId: loaded.order.restaurantId,
          },
          closedIncidentId,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          message:
            'Un remboursement vient d’être ouvert sur cette commande. Rechargez la fiche.',
          code: 'REFUND_IN_FLIGHT',
        });
      }
      throw error;
    }

    this.logger.warn(
      `💸 Remboursement composé — ${created.composition.totalXaf} XAF, commande ${orderId}, ` +
        `motif ${dto.reasonCode}, à la charge de ${bearer}, par ${adminId}`,
    );

    if (created.closedIncidentId) {
      this.events.emit(CLAIM_RESOLVED_EVENT, {
        incidentId: created.closedIncidentId,
        orderId,
        userId: created.order.userId,
        restaurantId: created.order.restaurantId,
        outcome: 'REFUNDED',
        amountXaf: created.composition.totalXaf,
        bearer,
      } satisfies ClaimResolvedEvent);
    }

    // Le virement part tout de suite par défaut : l'administrateur vient de
    // décider, lui imposer un second geste dans une autre file n'ajoute rien.
    // Un refus (mode MANUAL, prestataire) laisse la dette PENDING en file.
    let execution: { executed: boolean; status: string; message: string } = {
      executed: false,
      status: RefundStatus.PENDING,
      message: 'Remboursement laissé dans la file « Remboursements ».',
    };
    if (dto.execute !== false) {
      try {
        const result = await this.execution.execute(created.refundId, adminId);
        execution = { executed: true, ...result };
      } catch (error) {
        execution = {
          executed: false,
          status: RefundStatus.PENDING,
          message: `Virement non parti, remboursement laissé en file : ${(error as Error).message}`,
        };
      }
    }

    return {
      refundId: created.refundId,
      amountXaf: created.composition.totalXaf,
      bearer,
      lines: created.composition.lines,
      remainingAfterXaf: created.composition.remainingAfterXaf,
      execution,
    };
  }

  private compose(
    loaded: Awaited<ReturnType<RefundComposerService['load']>>,
    lines: ComposeRefundDto['lines'],
    allowEmpty: boolean,
  ): RefundComposition {
    try {
      return composeRefund(loaded.refundable, loaded.prior, lines, {
        allowEmpty,
      });
    } catch (error) {
      if (error instanceof RefundCompositionError) {
        throw new BadRequestException({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  }

  private async load(db: Db, orderId: string) {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        userId: true,
        restaurantId: true,
        total: true,
        deliveryFee: true,
        serviceFee: true,
        failureLiability: true,
        items: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            quantite: true,
            prix: true,
            snapshotPrice: true,
            variantLabel: true,
            product: { select: { nom: true } },
            menu: { select: { nom: true } },
          },
        },
        Payment: {
          where: { status: 'SUCCESS' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, amount: true },
        },
        payout: { select: { status: true } },
        refunds: {
          where: { status: { in: COUNTED_REFUND_STATUSES } },
          select: {
            status: true,
            amount: true,
            lines: {
              select: {
                kind: true,
                orderItemId: true,
                quantity: true,
                amountXaf: true,
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictException({
        message:
          'Seule une commande livrée (ou dont la livraison a échoué) se rembourse en partie. ' +
          'Une commande annulée est remboursée en totalité, automatiquement.',
        code: 'ORDER_NOT_REFUNDABLE',
      });
    }
    const payment = order.Payment[0];
    if (!payment || payment.amount <= 0) {
      throw new ConflictException({
        message:
          'Aucun encaissement abouti sur cette commande : rien à rembourser. Proposez un avoir.',
        code: 'PAYMENT_NOT_COMPLETED',
      });
    }

    const refundable: RefundableOrder = {
      paidXaf: Math.min(Math.round(order.total), payment.amount),
      deliveryFee: Math.round(order.deliveryFee),
      serviceFee: Math.round(order.serviceFee),
      items: order.items.map((it) => ({
        id: it.id,
        label: itemLabel(it),
        quantite: it.quantite,
        unitPriceXaf: Math.round(it.snapshotPrice ?? it.prix),
      })),
    };

    return {
      order,
      refundable,
      prior: order.refunds,
      paymentId: payment.id,
      payoutStatus: order.payout?.status ?? null,
      inFlight: order.refunds.some((r) =>
        IN_FLIGHT_REFUND_STATUSES.includes(r.status),
      ),
    };
  }
}

/** Libellé lisible d'un article de commande (« Menu midi · Alloco (grand) »). */
export function itemLabel(it: {
  variantLabel: string | null;
  product: { nom: string };
  menu: { nom: string } | null;
}): string {
  const variant =
    it.variantLabel && it.variantLabel.toLowerCase() !== 'default'
      ? ` (${it.variantLabel})`
      : '';
  const base = `${it.product.nom}${variant}`;
  return it.menu ? `${it.menu.nom} · ${base}` : base;
}

/**
 * R-06.5 — tant que le grand livre vendeur (F3-07) n'existe pas, une perte à
 * la charge du vendeur ne s'impute que sur un reversement pas encore parti.
 */
function vendorBlock(payoutStatus: string | null): string | null {
  if (payoutStatus === 'SUCCESS') {
    return 'Le vendeur a déjà été payé pour cette commande : la retenue sur son reversement n’existe pas encore après coup (F3-07). Choisissez « Lilia » comme payeur, ou réglez avec le vendeur hors système.';
  }
  if (payoutStatus === 'PENDING') {
    return 'Un reversement au vendeur est en cours : attendez son issue avant d’imputer un remboursement au vendeur.';
  }
  return null;
}

/**
 * Clôt une réclamation avec son issue, et en informe le client dans le fil.
 * Partagé par le remboursement, l'avoir et le refus : une seule façon de
 * clore, donc une seule façon de l'afficher.
 */
export async function closeClaim(
  tx: Prisma.TransactionClient,
  params: {
    incidentId: string;
    adminId: string;
    outcome: ClaimResolvedEvent['outcome'];
    resolution: string;
    clientMessage: string;
    extraMetadata?: Record<string, unknown>;
  },
): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({
    where: { id: params.incidentId },
    select: { metadata: true },
  });
  const metadata =
    incident.metadata && typeof incident.metadata === 'object'
      ? (incident.metadata as Record<string, unknown>)
      : {};
  await tx.incident.update({
    where: { id: params.incidentId },
    data: {
      status: IncidentStatus.RESOLVED,
      resolution: params.resolution,
      resolvedAt: new Date(),
      resolvedBy: params.adminId,
      metadata: {
        ...metadata,
        outcome: params.outcome,
        ...(params.extraMetadata ?? {}),
      } as Prisma.InputJsonValue,
    },
  });
  await tx.incidentMessage.create({
    data: {
      incidentId: params.incidentId,
      authorId: params.adminId,
      authorRole: Role.ADMIN,
      visibility: MessageVisibility.ALL,
      body: params.clientMessage,
    },
  });
}
