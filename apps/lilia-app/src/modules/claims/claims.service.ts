import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DiscountType,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  MessageVisibility,
  OrderStatus,
  Prisma,
  PromoFunding,
  RefundBearer,
  RefundStatus,
  Role,
  User,
} from '@prisma/client';
import { randomInt } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import {
  CLAIM_RESOLVED_EVENT,
  ClaimResolvedEvent,
  closeClaim,
  itemLabel,
} from '../refunds/refund-composer.service';
import {
  claimWindowClosesAt,
  CLAIM_WINDOW_HOURS,
  isClaimWindowOpen,
} from '../refunds/refund-lines.policy';
import type { IncidentCreatedEvent } from '../incidents/incidents.service';
import {
  ClaimListQueryDto,
  ClaimReason,
  CreateClaimDto,
  IssueVoucherDto,
  ITEM_CLAIM_REASONS,
  PostClaimMessageDto,
  RejectClaimDto,
} from './dto/claim.dto';

export const CLAIM_OPENED_EVENT = 'claim.opened';
export const CLAIM_MESSAGE_POSTED_EVENT = 'claim.message.posted';

export interface ClaimOpenedEvent {
  incidentId: string;
  orderId: string;
  userId: string;
  restaurantId: string;
  summary: string;
}

export interface ClaimMessagePostedEvent {
  incidentId: string;
  orderId: string;
  /** Auteur de la réclamation (le client). */
  userId: string;
  restaurantId: string;
  authorRole: Role;
  visibility: MessageVisibility;
}

export const CLAIM_REASON_LABELS: Record<ClaimReason, string> = {
  MISSING_ITEM: 'Article manquant',
  WRONG_ITEM: 'Article erroné',
  DAMAGED: 'Article abîmé ou renversé',
  LATE: 'Livraison très en retard',
  OTHER: 'Autre problème',
};

/** R-06.8 — au-delà, plus d'auto-proposition : revue manuelle obligatoire. */
export const MAX_ACCEPTED_CLAIMS_30D = 3;

/** Avoir : validité par défaut (R-06.6, ASSUMED). */
export const VOUCHER_DEFAULT_DAYS = 30;

const OPEN_STATUSES: IncidentStatus[] = [
  IncidentStatus.OPEN,
  IncidentStatus.IN_PROGRESS,
];

/**
 * Une « réclamation » est un incident de commande remonté par le client : le
 * nouveau type `CUSTOMER_CLAIM`, et les signalements Phase 2
 * (`POST /incidents/orders/:id/report`, `metadata.source = CUSTOMER`) — une
 * seule file, un seul fil, quel que soit le bouton d'origine (R-06.7).
 */
const CLAIM_WHERE: Prisma.IncidentWhereInput = {
  orderId: { not: null },
  OR: [
    { type: IncidentType.CUSTOMER_CLAIM },
    { metadata: { path: ['source'], equals: 'CUSTOMER' } },
  ],
};

const fmt = (n: number) => `${n.toLocaleString('fr-FR')} FCFA`;
const orderRef = (orderId: string) => orderId.slice(-8).toUpperCase();

interface ClaimMetadata {
  source?: string;
  kind?: string;
  outcome?: ClaimResolvedEvent['outcome'];
  claim?: {
    reason: ClaimReason;
    items: { orderItemId: string; quantity: number; label: string }[];
    photoUrls: string[];
  };
  voucher?: { code: string; amountXaf: number; expiresAt: string };
}

type Viewer = Pick<User, 'id' | 'role'>;

/**
 * Réclamations client (F3-06) : ouverture, fil de discussion, issue.
 *
 * Le montant n'est jamais décidé ici : un remboursement passe par le
 * composeur (`RefundComposerService`), qui clôt la réclamation dans sa
 * transaction. Ce service porte ce qui n'est pas de l'argent — qui voit quoi,
 * qui peut écrire, et l'avoir, qui n'est qu'un code promo nominatif.
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Ouverture ────────────────────────────────────────────────────────────

  async open(orderId: string, user: Viewer, dto: CreateClaimDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        status: true,
        restaurantId: true,
        updatedAt: true,
        delivery: { select: { deliveredAt: true, delivererId: true } },
        orderHistory: {
          where: { toStatus: OrderStatus.LIVRER },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
        items: {
          select: {
            id: true,
            quantite: true,
            variantLabel: true,
            product: { select: { nom: true } },
            menu: { select: { nom: true } },
          },
        },
      },
    });
    // Même réponse pour « inexistante » et « pas à vous » : pas d'oracle.
    if (!order || order.userId !== user.id) {
      throw new NotFoundException('Commande introuvable.');
    }
    if (order.status !== OrderStatus.LIVRER) {
      throw new BadRequestException({
        message:
          'Une réclamation s’ouvre sur une commande livrée. Pour une commande jamais reçue, utilisez « Signaler un problème ».',
        code: 'CLAIM_NOT_DELIVERED',
      });
    }
    const deliveredAt =
      order.delivery?.deliveredAt ??
      order.orderHistory[0]?.createdAt ??
      order.updatedAt;
    if (!isClaimWindowOpen(deliveredAt, new Date())) {
      throw new BadRequestException({
        message: `Le délai de réclamation (${CLAIM_WINDOW_HOURS} h après la livraison) est dépassé.`,
        code: 'CLAIM_WINDOW_CLOSED',
      });
    }

    // Articles : ceux de la commande, en quantité commandée au plus.
    const requested = dto.items ?? [];
    if (ITEM_CLAIM_REASONS.includes(dto.reason) && requested.length === 0) {
      throw new BadRequestException({
        message: 'Indiquez le ou les articles concernés.',
        code: 'CLAIM_ITEMS_REQUIRED',
      });
    }
    const seen = new Set<string>();
    const items = requested.map((r) => {
      const item = order.items.find((i) => i.id === r.orderItemId);
      if (!item || seen.has(item.id)) {
        throw new BadRequestException({
          message: "Un article indiqué n'appartient pas à la commande.",
          code: 'CLAIM_ITEM_UNKNOWN',
        });
      }
      seen.add(item.id);
      if (r.quantity > item.quantite) {
        throw new BadRequestException({
          message: `« ${itemLabel(item)} » : ${item.quantite} commandé(s) au plus.`,
          code: 'CLAIM_ITEM_QUANTITY',
        });
      }
      return {
        orderItemId: item.id,
        quantity: r.quantity,
        label: itemLabel(item),
      };
    });

    const reasonLabel = CLAIM_REASON_LABELS[dto.reason];
    const summary = items.length
      ? `${reasonLabel} : ${items.map((i) => `${i.quantity}× ${i.label}`).join(', ')}`
      : reasonLabel;
    const photoUrls = dto.photoUrls ?? [];

    let incidentId: string;
    try {
      incidentId = await this.prisma.$transaction(async (tx) => {
        const incident = await tx.incident.create({
          data: {
            type: IncidentType.CUSTOMER_CLAIM,
            severity: IncidentSeverity.MEDIUM,
            title: `Réclamation #${orderRef(orderId)} — ${reasonLabel}`,
            description: summary,
            orderId,
            riderId: order.delivery?.delivererId ?? null,
            restaurantId: order.restaurantId,
            reportedBy: user.id,
            // R-06.7 — une réclamation ouverte par commande, tenue par l'index
            // unique partiel `Incident_dedupKey_open_uq`.
            dedupKey: `claim:${orderId}`,
            metadata: {
              source: 'CUSTOMER',
              kind: dto.reason,
              claim: { reason: dto.reason, items, photoUrls },
            } satisfies ClaimMetadata as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        await tx.incidentMessage.create({
          data: {
            incidentId: incident.id,
            authorId: user.id,
            authorRole: Role.CLIENT,
            visibility: MessageVisibility.ALL,
            body: dto.note?.trim() || summary,
            attachments: photoUrls,
          },
        });
        return incident.id;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.incident.findFirst({
          where: {
            dedupKey: `claim:${orderId}`,
            status: { in: OPEN_STATUSES },
          },
          select: { id: true },
        });
        throw new ConflictException({
          message:
            'Une réclamation est déjà en cours sur cette commande : suivez-la dans « Mes demandes ».',
          code: 'CLAIM_ALREADY_OPEN',
          claimId: existing?.id ?? null,
        });
      }
      throw error;
    }

    this.logger.log(`Réclamation ${incidentId} ouverte sur ${orderId}`);
    // Les administrateurs sont prévenus par le canal commun des incidents.
    this.events.emit('incident.created', {
      incidentId,
      type: IncidentType.CUSTOMER_CLAIM,
      severity: IncidentSeverity.MEDIUM,
      orderId,
      riderId: order.delivery?.delivererId ?? null,
      restaurantId: order.restaurantId,
    } satisfies IncidentCreatedEvent);
    this.events.emit(CLAIM_OPENED_EVENT, {
      incidentId,
      orderId,
      userId: user.id,
      restaurantId: order.restaurantId,
      summary,
    } satisfies ClaimOpenedEvent);

    return this.findOne(incidentId, user);
  }

  // ─── Lecture ──────────────────────────────────────────────────────────────

  async list(user: Viewer, query: ClaimListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.IncidentWhereInput = {
      AND: [
        CLAIM_WHERE,
        await this.scopeFor(user),
        query.status ? { status: query.status } : {},
        query.state === 'open'
          ? { status: { in: OPEN_STATUSES } }
          : query.state === 'closed'
            ? { status: { notIn: OPEN_STATUSES } }
            : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.incident.findMany({
        where,
        // La file de travail : la plus ancienne demande ouverte d'abord pour
        // le support ; le client et le vendeur voient la plus récente d'abord.
        orderBy: { createdAt: user.role === Role.ADMIN ? 'asc' : 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          orderId: true,
          status: true,
          title: true,
          description: true,
          metadata: true,
          createdAt: true,
          resolvedAt: true,
          resolution: true,
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.incident.count({ where }),
    ]);
    return {
      data: rows.map((r) => {
        const meta = asMeta(r.metadata);
        return {
          id: r.id,
          orderId: r.orderId,
          orderRef: orderRef(r.orderId!),
          status: r.status,
          reason: meta.claim?.reason ?? meta.kind ?? 'OTHER',
          summary: r.description,
          outcome: meta.outcome ?? null,
          resolution: r.resolution,
          messagesCount: r._count.messages,
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
          ...(user.role === Role.ADMIN ? { title: r.title } : {}),
        };
      }),
      meta: { page, limit, total },
    };
  }

  async findOne(id: string, user: Viewer) {
    const claim = await this.accessible(id, user);
    const isStaff = user.role !== Role.CLIENT;
    const meta = asMeta(claim.metadata);

    const [messages, refunds, order] = await Promise.all([
      this.prisma.incidentMessage.findMany({
        where: {
          incidentId: id,
          ...(isStaff ? {} : { visibility: MessageVisibility.ALL }),
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          authorId: true,
          authorRole: true,
          visibility: true,
          body: true,
          attachments: true,
          createdAt: true,
        },
      }),
      this.prisma.refund.findMany({
        where: { orderId: claim.orderId! },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          amount: true,
          status: true,
          bearer: true,
          reasonCode: true,
          incidentId: true,
          createdAt: true,
          processedAt: true,
        },
      }),
      this.prisma.order.findUniqueOrThrow({
        where: { id: claim.orderId! },
        select: {
          id: true,
          total: true,
          status: true,
          createdAt: true,
          userId: true,
          restaurant: { select: { id: true, nom: true } },
          user: { select: { id: true, nom: true, phone: true } },
          delivery: { select: { deliveredAt: true } },
        },
      }),
    ]);

    const vendorImpactXaf = refunds
      .filter(
        (r) =>
          r.bearer === RefundBearer.VENDOR &&
          r.status !== RefundStatus.REJECTED,
      )
      .reduce((s, r) => s + r.amount, 0);

    return {
      data: {
        id: claim.id,
        orderId: claim.orderId,
        orderRef: orderRef(claim.orderId!),
        status: claim.status,
        reason: meta.claim?.reason ?? meta.kind ?? 'OTHER',
        summary: claim.description,
        items: meta.claim?.items ?? [],
        photoUrls: meta.claim?.photoUrls ?? [],
        outcome: meta.outcome ?? null,
        resolution: claim.resolution,
        voucher: meta.voucher ?? null,
        createdAt: claim.createdAt,
        resolvedAt: claim.resolvedAt,
        claimWindowClosesAt: order.delivery?.deliveredAt
          ? claimWindowClosesAt(order.delivery.deliveredAt)
          : null,
        order: {
          id: order.id,
          total: order.total,
          status: order.status,
          createdAt: order.createdAt,
          restaurant: order.restaurant,
        },
        messages: messages.map((m) => ({
          id: m.id,
          authorRole: m.authorRole,
          authorLabel: authorLabel(m.authorRole, m.authorId === user.id),
          mine: m.authorId === user.id,
          body: m.body,
          attachments: Array.isArray(m.attachments) ? m.attachments : [],
          createdAt: m.createdAt,
          ...(isStaff ? { visibility: m.visibility } : {}),
        })),
        // Le client voit ce qui lui revient ; le payeur est une affaire interne.
        refunds: refunds.map((r) => ({
          id: r.id,
          amountXaf: r.amount,
          status: r.status,
          createdAt: r.createdAt,
          processedAt: r.processedAt,
          fromThisClaim: r.incidentId === claim.id,
          ...(isStaff ? { bearer: r.bearer, reasonCode: r.reasonCode } : {}),
        })),
        // Vendeur : « 1 500 FCFA seront déduits de votre prochain reversement ».
        ...(isStaff ? { vendorImpactXaf } : {}),
        ...(user.role === Role.ADMIN
          ? {
              title: claim.title,
              customer: order.user,
              abuse: await this.abuseScore(order.userId),
            }
          : {}),
      },
    };
  }

  /**
   * R-06.8 — le passé du client, exposé au support. Au-delà de
   * `MAX_ACCEPTED_CLAIMS_30D` réclamations acceptées sur 30 jours, la revue
   * manuelle est obligatoire (aucune proposition automatique).
   */
  async abuseScore(userId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const base: Prisma.IncidentWhereInput = {
      AND: [CLAIM_WHERE, { reportedBy: userId }],
    };
    const [claims30d, accepted30d] = await Promise.all([
      this.prisma.incident.count({
        where: { ...base, createdAt: { gte: since } },
      }),
      this.prisma.incident.count({
        where: {
          AND: [
            base,
            { resolvedAt: { gte: since } },
            {
              OR: [
                { metadata: { path: ['outcome'], equals: 'REFUNDED' } },
                { metadata: { path: ['outcome'], equals: 'VOUCHER' } },
              ],
            },
          ],
        },
      }),
    ]);
    return {
      claims30d,
      accepted30d,
      manualReviewRequired: accepted30d > MAX_ACCEPTED_CLAIMS_30D,
    };
  }

  // ─── Fil ──────────────────────────────────────────────────────────────────

  async postMessage(id: string, user: Viewer, dto: PostClaimMessageDto) {
    const claim = await this.accessible(id, user);
    if (claim.status === IncidentStatus.CLOSED) {
      throw new ConflictException({
        message: 'Cette demande est close.',
        code: 'CLAIM_CLOSED',
      });
    }
    // La visibilité se déduit du rôle ; seul le support la choisit.
    const visibility =
      user.role === Role.CLIENT
        ? MessageVisibility.ALL
        : user.role === Role.RESTAURATEUR
          ? MessageVisibility.STAFF_ONLY
          : (dto.visibility ?? MessageVisibility.ALL);

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.incidentMessage.create({
        data: {
          incidentId: id,
          authorId: user.id,
          authorRole: user.role,
          visibility,
          body: dto.body.trim(),
          attachments: dto.attachments ?? [],
        },
        select: { id: true },
      });
      // Le client qui répond à une demande traitée la rouvre : il conteste.
      // Le support qui répond prend la demande en charge.
      if (
        user.role === Role.CLIENT &&
        claim.status === IncidentStatus.RESOLVED
      ) {
        await tx.incident.update({
          where: { id },
          data: { status: IncidentStatus.OPEN, resolvedAt: null },
        });
      } else if (
        user.role === Role.ADMIN &&
        claim.status === IncidentStatus.OPEN
      ) {
        await tx.incident.update({
          where: { id },
          data: { status: IncidentStatus.IN_PROGRESS },
        });
      }
      return created;
    });

    this.events.emit(CLAIM_MESSAGE_POSTED_EVENT, {
      incidentId: id,
      orderId: claim.orderId!,
      userId: claim.reportedBy!,
      restaurantId: claim.restaurantId!,
      authorRole: user.role,
      visibility,
    } satisfies ClaimMessagePostedEvent);

    return { data: { id: message.id } };
  }

  // ─── Issues sans remboursement ────────────────────────────────────────────

  /**
   * Avoir (R-06.6) : un code promo nominatif, à usage unique, financé par la
   * plateforme. Proposé quand le client le préfère, ou quand le montant est
   * trop faible pour justifier un virement.
   */
  async issueVoucher(id: string, admin: Viewer, dto: IssueVoucherDto) {
    const claim = await this.accessible(id, admin);
    if (!claim.reportedBy) {
      throw new BadRequestException('Réclamation sans client identifié.');
    }
    const meta = asMeta(claim.metadata);
    if (meta.voucher) {
      throw new ConflictException({
        message: `Un avoir a déjà été émis sur cette réclamation (${meta.voucher.code}).`,
        code: 'VOUCHER_ALREADY_ISSUED',
      });
    }
    const days = dto.expiresInDays ?? VOUCHER_DEFAULT_DAYS;
    const expiresAt = new Date(Date.now() + days * 86_400_000);

    let voucher: { id: string; code: string };
    try {
      voucher = await this.prisma.$transaction(async (tx) => {
        // Une violation d'unicité avorte la transaction PostgreSQL : pas de
        // nouvel essai ici. 31⁸ codes possibles, la collision est théorique —
        // et, le cas échéant, l'administrateur reclique.
        const promo = await tx.promoCode.create({
          data: {
            code: voucherCode(),
            description: `Avoir — réclamation sur la commande #${orderRef(claim.orderId!)}`,
            discountType: DiscountType.FIXED,
            discountValue: dto.amountXaf,
            minOrderAmount: 0,
            maxUsageTotal: 1,
            maxUsagePerUser: 1,
            assignedUserId: claim.reportedBy,
            fundingSource: PromoFunding.PLATFORM,
            expiresAt,
          },
          select: { id: true, code: true },
        });

        const expires = expiresAt.toLocaleDateString('fr-FR', {
          timeZone: 'Africa/Brazzaville',
        });
        await closeClaim(tx, {
          incidentId: id,
          adminId: admin.id,
          outcome: 'VOUCHER',
          resolution: `Avoir de ${fmt(dto.amountXaf)} (${promo.code}).`,
          clientMessage:
            `Nous vous offrons un avoir de ${fmt(dto.amountXaf)} : saisissez le code ` +
            `${promo.code} à votre prochaine commande (valable jusqu’au ${expires}).`,
          extraMetadata: {
            voucher: {
              promoCodeId: promo.id,
              code: promo.code,
              amountXaf: dto.amountXaf,
              expiresAt: expiresAt.toISOString(),
            },
          },
        });
        return promo;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Code d’avoir déjà pris : réessayez.');
      }
      throw error;
    }

    this.emitResolved(claim, 'VOUCHER', dto.amountXaf);
    return {
      data: { code: voucher.code, amountXaf: dto.amountXaf, expiresAt },
    };
  }

  async reject(id: string, admin: Viewer, dto: RejectClaimDto) {
    const claim = await this.accessible(id, admin);
    await this.prisma.$transaction((tx) =>
      closeClaim(tx, {
        incidentId: id,
        adminId: admin.id,
        outcome: 'REJECTED',
        resolution: dto.reason.trim(),
        clientMessage: `Nous ne pouvons pas donner suite à votre demande : ${dto.reason.trim()}`,
      }),
    );
    this.emitResolved(claim, 'REJECTED', 0);
    return { data: { id, status: IncidentStatus.RESOLVED } };
  }

  // ─── Accès ────────────────────────────────────────────────────────────────

  /** Ce que chaque rôle voit : le client, les siennes ; le vendeur, sa boutique. */
  private async scopeFor(user: Viewer): Promise<Prisma.IncidentWhereInput> {
    if (user.role === Role.ADMIN) return {};
    if (user.role === Role.RESTAURATEUR) {
      const owned = await this.prisma.restaurant.findMany({
        where: { ownerId: user.id },
        select: { id: true },
      });
      return { restaurantId: { in: owned.map((r) => r.id) } };
    }
    return { reportedBy: user.id };
  }

  /** 404 uniforme : une réclamation d'autrui n'existe pas. */
  private async accessible(id: string, user: Viewer) {
    const claim = await this.prisma.incident.findFirst({
      where: { AND: [{ id }, CLAIM_WHERE, await this.scopeFor(user)] },
    });
    if (!claim) throw new NotFoundException('Demande introuvable.');
    return claim;
  }

  private emitResolved(
    claim: {
      id: string;
      orderId: string | null;
      reportedBy: string | null;
      restaurantId: string | null;
    },
    outcome: ClaimResolvedEvent['outcome'],
    amountXaf: number,
  ) {
    this.events.emit(CLAIM_RESOLVED_EVENT, {
      incidentId: claim.id,
      orderId: claim.orderId!,
      userId: claim.reportedBy!,
      restaurantId: claim.restaurantId!,
      outcome,
      amountXaf,
    } satisfies ClaimResolvedEvent);
  }
}

function asMeta(metadata: Prisma.JsonValue | null): ClaimMetadata {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as ClaimMetadata)
    : {};
}

/** L'identité des agents ne sort pas : le client parle au « service client ». */
function authorLabel(role: Role, mine: boolean): string {
  if (mine) return 'Vous';
  switch (role) {
    case Role.ADMIN:
      return 'Service client Lilia';
    case Role.RESTAURATEUR:
      return 'Vendeur';
    case Role.LIVREUR:
      return 'Livreur';
    default:
      return 'Client';
  }
}

/** Alphabet sans caractères ambigus (0/O, 1/I/L) : le code se dicte au téléphone. */
const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function voucherCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += VOUCHER_ALPHABET[randomInt(VOUCHER_ALPHABET.length)];
  }
  return `AVOIR-${s}`;
}
