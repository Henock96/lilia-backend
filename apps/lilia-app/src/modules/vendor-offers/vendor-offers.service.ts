import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  Prisma,
  VendorOffer,
  VendorOfferStatus,
} from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import { CATALOG_CHANGED, CatalogChangedEvent } from '../events/catalog-events';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { isPrismaError } from '../modifiers/prisma-errors';
import { OutboxService } from '../outbox/outbox.service';
import { VENDOR_OFFER_NOTICE_EVENT } from '../outbox/outbox-events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import {
  AdminVendorOffersQueryDto,
  CreateVendorOfferDto,
  VendorOfferAction,
} from './dto/vendor-offer.dto';
import {
  assertOfferTerms,
  capOfferToVendorNet,
  offerDiscountXaf,
  offerLabel,
  OfferTermsError,
  OfferTerms,
} from './vendor-offer-pricing';
import {
  AppliedVendorOffer,
  PublicVendorOffer,
} from './vendor-offer-projection';

export type { AppliedVendorOffer, PublicVendorOffer };

/**
 * Annulation ou expiration d'une commande : le budget consommé est rendu à
 * l'offre et la consommation supprimée. Idempotent — une seconde annulation
 * (client puis vendeur) ne trouve plus de consommation.
 *
 * Fonction et non méthode : elle s'exécute dans la transaction d'annulation de
 * `OrderLifecycleService`, qui n'a pas à dépendre du service entier. Jamais
 * dans un `@OnEvent` : le worker, qui expire les commandes impayées, n'a aucun
 * écouteur.
 *
 * Une offre `EXHAUSTED` le reste : la réactiver pourrait heurter l'index
 * « une offre active par vendeur » et faire échouer l'annulation elle-même.
 * Le vendeur en publie une autre s'il le souhaite.
 */
export async function releaseVendorOfferForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const redemption = await tx.vendorOfferRedemption.findUnique({
    where: { orderId },
  });
  if (!redemption) return 0;
  const deleted = await tx.vendorOfferRedemption.deleteMany({
    where: { id: redemption.id },
  });
  if (deleted.count === 0) return 0;
  await tx.$executeRaw`
    UPDATE "VendorOffer"
       SET "spentXaf" = GREATEST(0, "spentXaf" - ${redemption.discountXaf}),
           "updatedAt" = now()
     WHERE id = ${redemption.offerId}
  `;
  return redemption.discountXaf;
}

/** Seuil d'alerte budget (R-11 §11) : le vendeur est prévenu une fois. */
export const BUDGET_WARNING_RATIO = 0.8;

export type VendorOfferNoticeKind =
  | 'BUDGET_WARNING'
  | 'EXHAUSTED'
  | 'ENDED'
  | 'STOPPED';

/** Charge utile de `vendor.offer.notice`. */
export interface VendorOfferNoticePayload {
  offerId: string;
  restaurantId: string;
  /** `User.id` du propriétaire — destinataire du push. */
  ownerId: string;
  notice: VendorOfferNoticeKind;
  label: string;
  spentXaf: number;
  budgetXaf: number;
  reason?: string | null;
}

function toPublic(offer: VendorOffer): PublicVendorOffer {
  return {
    id: offer.id,
    kind: offer.kind,
    value: offer.value,
    minSubTotalXaf: offer.minSubTotalXaf,
    maxDiscountXaf: offer.maxDiscountXaf,
    endsAt: offer.endsAt,
    label: offerLabel(offer),
  };
}

export function vendorOfferChanged(): ConflictException {
  return new ConflictException({
    message:
      'L’offre de ce vendeur vient de changer. Vérifiez le nouveau total avant de valider.',
    code: 'VENDOR_OFFER_CHANGED',
  });
}

function offersDisabled(): BadRequestException {
  return new BadRequestException({
    message: 'Les offres boutique ne sont pas encore ouvertes sur Lilia Food.',
    code: 'VENDOR_OFFERS_DISABLED',
  });
}

/**
 * Offres boutique financées par le vendeur (F3-11).
 *
 * Trois familles de gestes :
 *  - le vendeur crée, met en pause, reprend et termine SES offres ;
 *  - l'administration liste et arrête d'urgence ;
 *  - le checkout résout l'offre applicable, réserve le budget dans sa
 *    transaction, et l'annulation le rend.
 */
@Injectable()
export class VendorOffersService {
  private readonly logger = new Logger(VendorOffersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly outbox: OutboxService,
    private readonly audit: AdminAuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Le badge « −10 % » vit dans la page vendeur mise en cache par le site :
   * on l'invalide à chaque changement d'offre. Sans garantie — le cache
   * expire de lui-même, et le checkout refuse (409) une offre périmée.
   */
  private touchCatalog(restaurantId: string, reason: string): void {
    this.eventEmitter.emit(
      CATALOG_CHANGED,
      new CatalogChangedEvent(restaurantId, reason),
    );
  }

  async isEnabled(): Promise<boolean> {
    return (await this.platformSettings.getSettings()).vendorOffersEnabled;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Vendeur
  // ══════════════════════════════════════════════════════════════════════════

  private async ownedRestaurant(ownerId: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { ownerId },
      select: { id: true, ownerId: true },
    });
    if (!restaurant) {
      throw new ForbiddenException(
        'Vous devez posséder un vendeur pour gérer des offres.',
      );
    }
    return restaurant;
  }

  async listMine(ownerId: string) {
    const restaurant = await this.ownedRestaurant(ownerId);
    const offers = await this.prisma.vendorOffer.findMany({
      where: { restaurantId: restaurant.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { _count: { select: { redemptions: true } } },
    });
    return {
      data: {
        enabled: await this.isEnabled(),
        offers: offers.map((o) => this.toOwnerView(o)),
      },
    };
  }

  async create(ownerId: string, dto: CreateVendorOfferDto) {
    if (!(await this.isEnabled())) throw offersDisabled();
    const restaurant = await this.ownedRestaurant(ownerId);
    const now = new Date();
    const terms = {
      kind: dto.kind,
      value: dto.value,
      minSubTotalXaf: dto.minSubTotalXaf ?? 0,
      maxDiscountXaf: dto.maxDiscountXaf ?? null,
      startsAt: now,
      endsAt: new Date(dto.endsAt),
      budgetXaf: dto.budgetXaf,
    };
    try {
      assertOfferTerms(terms, now);
    } catch (err) {
      if (err instanceof OfferTermsError) {
        throw new BadRequestException({ message: err.message, code: err.code });
      }
      throw err;
    }

    try {
      const offer = await this.prisma.vendorOffer.create({
        data: { ...terms, restaurantId: restaurant.id, createdBy: ownerId },
        include: { _count: { select: { redemptions: true } } },
      });
      this.logger.log(
        `🏷️ Offre ${offer.id} créée pour ${restaurant.id} : ${offerLabel(offer)}, budget ${offer.budgetXaf}`,
      );
      this.touchCatalog(restaurant.id, 'offre publiée');
      return { data: this.toOwnerView(offer), message: 'Offre publiée.' };
    } catch (err) {
      // Index unique partiel : une seule offre ACTIVE par vendeur (R-11.7).
      if (isPrismaError(err, 'P2002')) {
        throw new ConflictException({
          message:
            'Vous avez déjà une offre en cours. Terminez-la avant d’en publier une autre.',
          code: 'OFFER_ALREADY_ACTIVE',
        });
      }
      throw err;
    }
  }

  async update(ownerId: string, offerId: string, action: VendorOfferAction) {
    const restaurant = await this.ownedRestaurant(ownerId);
    const offer = await this.prisma.vendorOffer.findFirst({
      where: { id: offerId, restaurantId: restaurant.id },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');

    const transitions: Record<
      VendorOfferAction,
      { from: VendorOfferStatus[]; to: VendorOfferStatus }
    > = {
      PAUSE: { from: [VendorOfferStatus.ACTIVE], to: VendorOfferStatus.PAUSED },
      RESUME: {
        from: [VendorOfferStatus.PAUSED],
        to: VendorOfferStatus.ACTIVE,
      },
      END: {
        from: [VendorOfferStatus.ACTIVE, VendorOfferStatus.PAUSED],
        to: VendorOfferStatus.ENDED,
      },
    };
    const t = transitions[action];
    if (!t.from.includes(offer.status)) {
      throw new ConflictException({
        message: 'Cette offre ne peut plus être modifiée ainsi.',
        code: 'OFFER_STATUS_CONFLICT',
      });
    }
    if (action === 'RESUME') {
      if (!(await this.isEnabled())) throw offersDisabled();
      if (offer.endsAt <= new Date()) {
        throw new ConflictException({
          message: 'Cette offre est arrivée à échéance.',
          code: 'OFFER_STATUS_CONFLICT',
        });
      }
    }

    try {
      // Conditionné sur le statut lu : un checkout qui épuise le budget, ou
      // l'administration qui arrête l'offre, entre la lecture et l'écriture
      // gagne — on ne ressuscite pas une offre épuisée.
      const updated = await this.prisma.vendorOffer.updateMany({
        where: { id: offer.id, status: offer.status },
        data: { status: t.to },
      });
      if (updated.count === 0) {
        throw new ConflictException({
          message: 'Cette offre vient de changer. Rechargez la page.',
          code: 'OFFER_STATUS_CONFLICT',
        });
      }
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        throw new ConflictException({
          message:
            'Vous avez déjà une offre en cours. Terminez-la avant de reprendre celle-ci.',
          code: 'OFFER_ALREADY_ACTIVE',
        });
      }
      throw err;
    }

    this.touchCatalog(restaurant.id, `offre ${action.toLowerCase()}`);
    const fresh = await this.prisma.vendorOffer.findUniqueOrThrow({
      where: { id: offer.id },
      include: { _count: { select: { redemptions: true } } },
    });
    return { data: this.toOwnerView(fresh) };
  }

  private toOwnerView(
    offer: VendorOffer & { _count: { redemptions: number } },
  ) {
    return {
      id: offer.id,
      kind: offer.kind,
      value: offer.value,
      minSubTotalXaf: offer.minSubTotalXaf,
      maxDiscountXaf: offer.maxDiscountXaf,
      startsAt: offer.startsAt,
      endsAt: offer.endsAt,
      budgetXaf: offer.budgetXaf,
      spentXaf: offer.spentXaf,
      remainingXaf: offer.budgetXaf - offer.spentXaf,
      status: offer.status,
      stoppedReason: offer.stoppedReason,
      ordersCount: offer._count.redemptions,
      label: offerLabel(offer),
      createdAt: offer.createdAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Administration
  // ══════════════════════════════════════════════════════════════════════════

  async listAll(query: AdminVendorOffersQueryDto) {
    const where: Prisma.VendorOfferWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.vendorOffer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          restaurant: { select: { id: true, nom: true } },
          _count: { select: { redemptions: true } },
        },
      }),
      this.prisma.vendorOffer.count({ where }),
    ]);
    return {
      data: rows.map((o) => ({
        ...this.toOwnerView(o),
        restaurant: o.restaurant,
        stoppedBy: o.stoppedBy,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** Arrêt d'urgence (motif obligatoire, audit, vendeur prévenu). */
  async stop(adminId: string, offerId: string, reason: string) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      include: { restaurant: { select: { ownerId: true } } },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');
    const stoppable: VendorOfferStatus[] = [
      VendorOfferStatus.ACTIVE,
      VendorOfferStatus.PAUSED,
    ];
    if (!stoppable.includes(offer.status)) {
      throw new ConflictException({
        message: 'Cette offre est déjà terminée.',
        code: 'OFFER_STATUS_CONFLICT',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.vendorOffer.updateMany({
        where: { id: offer.id, status: { in: stoppable } },
        data: {
          status: VendorOfferStatus.STOPPED_BY_ADMIN,
          stoppedReason: reason,
          stoppedBy: adminId,
        },
      });
      if (updated.count === 0) {
        throw new ConflictException({
          message: 'Cette offre vient de se terminer.',
          code: 'OFFER_STATUS_CONFLICT',
        });
      }
      await this.enqueueNotice(tx, {
        offer,
        ownerId: offer.restaurant.ownerId,
        notice: 'STOPPED',
        reason,
      });
    });

    await this.audit.record({
      actorId: adminId,
      action: AdminAuditAction.VENDOR_OFFER_STOPPED,
      targetType: 'VendorOffer',
      targetId: offer.id,
      reason,
      metadata: {
        restaurantId: offer.restaurantId,
        label: offerLabel(offer),
        spentXaf: offer.spentXaf,
        budgetXaf: offer.budgetXaf,
      },
    });
    this.touchCatalog(offer.restaurantId, 'offre arrêtée par l’administration');
    return { message: 'Offre arrêtée. Le vendeur a été prévenu.' };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Checkout
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * L'offre qui s'applique à ce panier, et son montant — `null` si aucune.
   *
   * Le montant est plafonné deux fois :
   *  - au net vendeur (`capOfferToVendorNet`) : Lilia n'absorbe jamais le
   *    reste d'une remise que le reversement ne couvre pas (D8) ;
   *  - au budget restant : la dernière commande reçoit ce qui reste, plutôt
   *    qu'un refus qui bloquerait tout checkout sur ce vendeur.
   *
   * Lecture sans verrou : le checkout réserve ensuite sous condition
   * ({@link reserveInTransaction}), qui arbitre la concurrence.
   */
  async resolveForCart(params: {
    restaurantId: string;
    subTotalXaf: number;
    commissionAmountXaf: number;
    vendorDeliverySubsidyXaf: number;
    now?: Date;
  }): Promise<AppliedVendorOffer | null> {
    if (!(await this.isEnabled())) return null;
    const now = params.now ?? new Date();
    const offer = await this.prisma.vendorOffer.findFirst({
      where: {
        restaurantId: params.restaurantId,
        status: VendorOfferStatus.ACTIVE,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
    });
    if (!offer) return null;
    const discountXaf = Math.min(
      capOfferToVendorNet(offerDiscountXaf(offer, params.subTotalXaf), {
        subTotalXaf: params.subTotalXaf,
        commissionAmountXaf: params.commissionAmountXaf,
        vendorDeliverySubsidyXaf: params.vendorDeliverySubsidyXaf,
      }),
      offer.budgetXaf - offer.spentXaf,
    );
    if (discountXaf <= 0) return null;
    return { offer: toPublic(offer), discountXaf };
  }

  /**
   * Consomme le budget DANS la transaction de checkout, et fige la
   * consommation de la commande.
   *
   * `UPDATE … WHERE spentXaf + x ≤ budgetXaf` : deux checkouts simultanés ne
   * dépassent jamais le budget ; le perdant reçoit 409 `VENDOR_OFFER_CHANGED`
   * et relance son devis. La même condition refuse une offre mise en pause,
   * arrêtée ou échue entre le devis et le paiement.
   */
  async reserveInTransaction(
    tx: Prisma.TransactionClient,
    params: { offerId: string; orderId: string; discountXaf: number },
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        restaurantId: string;
        kind: VendorOffer['kind'];
        value: number;
        minSubTotalXaf: number;
        maxDiscountXaf: number | null;
        spentXaf: number;
        budgetXaf: number;
        budgetWarnedAt: Date | null;
      }[]
    >`
      UPDATE "VendorOffer"
         SET "spentXaf" = "spentXaf" + ${params.discountXaf},
             "updatedAt" = now()
       WHERE id = ${params.offerId}
         AND status = 'ACTIVE'
         AND "startsAt" <= now() AND now() < "endsAt"
         AND "spentXaf" + ${params.discountXaf} <= "budgetXaf"
      RETURNING id, "restaurantId", kind, value, "minSubTotalXaf",
                "maxDiscountXaf", "spentXaf", "budgetXaf", "budgetWarnedAt"
    `;
    if (rows.length === 0) throw vendorOfferChanged();
    const offer = rows[0];

    await tx.vendorOfferRedemption.create({
      data: {
        offerId: params.offerId,
        orderId: params.orderId,
        discountXaf: params.discountXaf,
      },
    });

    const owner = await tx.restaurant.findUniqueOrThrow({
      where: { id: offer.restaurantId },
      select: { ownerId: true },
    });

    if (offer.spentXaf >= offer.budgetXaf) {
      await tx.vendorOffer.update({
        where: { id: offer.id },
        data: { status: VendorOfferStatus.EXHAUSTED },
      });
      await this.enqueueNotice(tx, {
        offer,
        ownerId: owner.ownerId,
        notice: 'EXHAUSTED',
      });
    } else if (
      offer.budgetWarnedAt === null &&
      offer.spentXaf >= offer.budgetXaf * BUDGET_WARNING_RATIO
    ) {
      const marked = await tx.vendorOffer.updateMany({
        where: { id: offer.id, budgetWarnedAt: null },
        data: { budgetWarnedAt: new Date() },
      });
      if (marked.count > 0) {
        await this.enqueueNotice(tx, {
          offer,
          ownerId: owner.ownerId,
          notice: 'BUDGET_WARNING',
        });
      }
    }
  }

  /** Voir {@link releaseVendorOfferForOrder}. */
  releaseForOrder(tx: Prisma.TransactionClient, orderId: string) {
    return releaseVendorOfferForOrder(tx, orderId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Échéance (cron)
  // ══════════════════════════════════════════════════════════════════════════

  /** Passe en `ENDED` les offres échues, et prévient chaque vendeur. */
  async endExpired(now = new Date()): Promise<number> {
    const due = await this.prisma.vendorOffer.findMany({
      where: {
        status: { in: [VendorOfferStatus.ACTIVE, VendorOfferStatus.PAUSED] },
        endsAt: { lte: now },
      },
      include: { restaurant: { select: { ownerId: true } } },
      take: 100,
    });
    let ended = 0;
    for (const offer of due) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.vendorOffer.updateMany({
          where: { id: offer.id, status: offer.status },
          data: { status: VendorOfferStatus.ENDED },
        });
        if (updated.count === 0) return;
        ended += 1;
        this.touchCatalog(offer.restaurantId, 'offre échue');
        await this.enqueueNotice(tx, {
          offer,
          ownerId: offer.restaurant.ownerId,
          notice: 'ENDED',
        });
      });
    }
    return ended;
  }

  private async enqueueNotice(
    tx: Prisma.TransactionClient,
    params: {
      offer: OfferTerms & {
        id: string;
        restaurantId: string;
        spentXaf: number;
        budgetXaf: number;
      };
      ownerId: string;
      notice: VendorOfferNoticeKind;
      reason?: string | null;
    },
  ): Promise<void> {
    const payload: VendorOfferNoticePayload = {
      offerId: params.offer.id,
      restaurantId: params.offer.restaurantId,
      ownerId: params.ownerId,
      notice: params.notice,
      label: offerLabel(params.offer),
      spentXaf: params.offer.spentXaf,
      budgetXaf: params.offer.budgetXaf,
      reason: params.reason ?? null,
    };
    await this.outbox.enqueueInTransaction(tx, {
      type: VENDOR_OFFER_NOTICE_EVENT,
      aggregateId: params.offer.id,
      payload: payload as unknown as Prisma.InputJsonValue,
    });
  }
}
