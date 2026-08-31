import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import {
  OrderStatus,
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  PayoutStatus,
  Prisma,
  RefundStatus,
} from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../../prisma/prisma.service';
import { PlatformSettingsService } from '../../platform-settings/platform-settings.service';
import { PaymentProviderRegistry } from '../payment-provider.registry';
import {
  ProviderTransactionStatus,
  ProviderUnavailableError,
} from '../providers/payment-provider.interface';
import { computePayoutBreakdown, toXaf } from '../money.util';
import {
  PAYOUT_BLOCKING_STATUSES,
  PayoutStateMachine,
} from '../payout-state.machine';
import { PaymentEventService } from './payment-event.service';
import { maskPhone, maskRef, PaymentStatus } from './payment.service';

/**
 * Statuts de commande à partir desquels un vendeur peut être reversé.
 *
 * `PRET` est le seuil : le vendeur a fait son travail, la commande attend le
 * livreur ou le client. Les deux états suivants restent éligibles parce qu'un
 * administrateur qui n'a pas payé au moment de `PRET` doit pouvoir le faire
 * ensuite — un reversement oublié ne doit pas devenir impossible.
 *
 * ⚠️ `PRET` rend la commande **éligible**, il ne déclenche rien. Le passage à
 * `PRET` reste une transition purement opérationnelle : c'est une action
 * d'administration explicite qui envoie l'argent.
 */
export const PAYOUT_ELIGIBLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PRET,
  OrderStatus.EN_ROUTE,
  OrderStatus.LIVRER,
];

/** Motifs de non-éligibilité, destinés à l'affichage dans l'administration. */
export type PayoutIneligibilityCode =
  | 'ORDER_NOT_FOUND'
  | 'ORDER_CANCELLED'
  | 'ORDER_NOT_READY'
  | 'PAYMENT_NOT_COMPLETED'
  | 'ORDER_REFUNDED'
  | 'VENDOR_PAYOUT_ACCOUNT_MISSING'
  | 'PAYOUT_ALREADY_COMPLETED'
  | 'PAYOUT_IN_PROGRESS'
  | 'PROVIDER_DOES_NOT_SUPPORT_PAYOUT';

export interface PayoutEligibility {
  eligible: boolean;
  code?: PayoutIneligibilityCode;
  reason?: string;
  /** Décompte financier, présent dès que la commande et le vendeur sont connus. */
  breakdown?: {
    grossAmount: number;
    commissionPercent: number;
    commissionAmount: number;
    payoutAmount: number;
    currency: string;
  };
}

/**
 * Reversement d'un vendeur — **toujours déclenché à la main par un
 * administrateur**, jamais automatiquement.
 *
 * La règle métier posée par ce chantier tient en une phrase : *encaisser le
 * client et payer le vendeur sont deux décisions distinctes*. Aucun événement
 * — ni `payment.confirmed`, ni `order → PAYER`, ni `order → PRET` — ne déclenche
 * un virement. `PRET` rend seulement la commande **éligible** ; l'argent ne part
 * que sur `POST /admin/orders/:orderId/payout`.
 *
 * C'est ce qui laisse à Lilia Food le temps de constater un litige avant d'avoir
 * versé — un remboursement client est simple tant que le vendeur n'a pas été
 * payé, et devient une négociation ensuite.
 */
@Injectable()
export class RestaurantPayoutService {
  private readonly logger = new Logger(RestaurantPayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentProviderRegistry,
    private readonly settings: PlatformSettingsService,
    private readonly events: PaymentEventService,
    private readonly stateMachine: PayoutStateMachine,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Éligibilité — évaluée CÔTÉ SERVEUR, toujours
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * La commande peut-elle donner lieu à un reversement ?
   *
   * Sert deux usages : l'affichage dans l'administration (le bouton et son
   * motif de désactivation) **et** la garde à l'exécution. Le front peut
   * afficher ce qu'il veut — c'est cette méthode, rejouée au moment du clic,
   * qui décide.
   */
  async checkEligibility(orderId: string): Promise<PayoutEligibility> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        restaurant: {
          select: {
            id: true,
            nom: true,
            commissionPercent: true,
            payoutPhoneNumber: true,
            payoutProvider: true,
          },
        },
        Payment: { select: { status: true, amount: true } },
        refund: { select: { status: true } },
        payout: { select: { id: true, status: true } },
      },
    });

    if (!order) {
      return {
        eligible: false,
        code: 'ORDER_NOT_FOUND',
        reason: 'Commande introuvable.',
      };
    }

    const breakdown = await this.buildBreakdown(
      order.subTotal,
      order.restaurant.commissionPercent,
    );
    const withBreakdown = (result: PayoutEligibility): PayoutEligibility => ({
      ...result,
      breakdown: { ...breakdown, currency: 'XAF' },
    });

    // Ordre des contrôles : du plus définitif au plus corrigeable, pour que le
    // motif affiché soit celui sur lequel l'administrateur peut agir.
    if (order.payout?.status === PayoutStatus.SUCCESS) {
      return withBreakdown({
        eligible: false,
        code: 'PAYOUT_ALREADY_COMPLETED',
        reason: 'Ce vendeur a déjà été payé pour cette commande.',
      });
    }
    if (order.payout?.status === PayoutStatus.PENDING) {
      return withBreakdown({
        eligible: false,
        code: 'PAYOUT_IN_PROGRESS',
        reason: 'Un reversement est déjà en cours pour cette commande.',
      });
    }
    if (order.status === OrderStatus.ANNULER) {
      return withBreakdown({
        eligible: false,
        code: 'ORDER_CANCELLED',
        reason: 'Cette commande est annulée.',
      });
    }
    if (!PAYOUT_ELIGIBLE_ORDER_STATUSES.includes(order.status)) {
      return withBreakdown({
        eligible: false,
        code: 'ORDER_NOT_READY',
        reason:
          `La commande est au statut ${order.status}. Le vendeur peut être payé ` +
          `à partir de « PRET ».`,
      });
    }

    const paid = order.Payment.some((p) => p.status === PaymentStatus.SUCCESS);
    if (!paid) {
      return withBreakdown({
        eligible: false,
        code: 'PAYMENT_NOT_COMPLETED',
        reason: "Le paiement du client n'est pas encaissé.",
      });
    }

    // Un remboursement ouvert signifie que l'argent est dû au client. Reverser
    // le vendeur dans cet intervalle, c'est payer deux fois la même commande.
    if (order.refund && order.refund.status !== RefundStatus.REJECTED) {
      return withBreakdown({
        eligible: false,
        code: 'ORDER_REFUNDED',
        reason:
          'Un remboursement est ouvert sur cette commande. Traitez-le avant de payer le vendeur.',
      });
    }

    if (
      !order.restaurant.payoutPhoneNumber ||
      !order.restaurant.payoutProvider
    ) {
      return withBreakdown({
        eligible: false,
        code: 'VENDOR_PAYOUT_ACCOUNT_MISSING',
        reason:
          'Impossible de payer le vendeur : aucun compte Mobile Money de reversement ' +
          'configuré. Renseignez-le dans la fiche du vendeur.',
      });
    }

    if (!this.registry.forPayout()) {
      return withBreakdown({
        eligible: false,
        code: 'PROVIDER_DOES_NOT_SUPPORT_PAYOUT',
        reason:
          `Le mode de paiement actuel (${this.registry.currentMode}) ne permet pas ` +
          'de reverser automatiquement. Effectuez le virement manuellement.',
      });
    }

    return withBreakdown({ eligible: true });
  }

  /**
   * Taux applicable : celui du vendeur s'il en a un, sinon celui de la
   * plateforme. Jamais une constante — le taux n'est pas arrêté et doit pouvoir
   * varier par vendeur sans toucher au code.
   */
  private async resolveCommissionPercent(
    vendorPercent: number | null,
  ): Promise<number> {
    if (vendorPercent !== null && Number.isFinite(vendorPercent)) {
      return vendorPercent;
    }
    const settings = await this.settings.getSettings();
    return settings.restaurantCommissionPercent;
  }

  private async buildBreakdown(subTotal: number, vendorPercent: number | null) {
    const commissionPercent =
      await this.resolveCommissionPercent(vendorPercent);
    return computePayoutBreakdown({
      subTotalXaf: toXaf(subTotal, 'sous-total'),
      commissionPercent,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Déclenchement
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Déclenche le reversement d'une commande.
   *
   * **Concurrence** : deux administrateurs cliquant à la même milliseconde
   * passeraient tous deux `checkEligibility`. Ce n'est pas elle qui protège,
   * c'est la contrainte `@@unique([orderId])` sur `restaurant_payouts` : la
   * seconde insertion reçoit un `P2002` que l'on traduit en 409. La base
   * arbitre, et elle ne peut pas se tromper.
   */
  async requestPayout(params: { orderId: string; adminUserId: string }) {
    const eligibility = await this.checkEligibility(params.orderId);
    if (!eligibility.eligible) {
      throw new ConflictException({
        message: eligibility.reason ?? 'Reversement impossible.',
        code: eligibility.code,
      });
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: params.orderId },
      include: {
        restaurant: {
          select: {
            id: true,
            nom: true,
            ownerId: true,
            commissionPercent: true,
            payoutPhoneNumber: true,
            payoutProvider: true,
          },
        },
      },
    });

    // Le décompte est RECALCULÉ ici, côté serveur, à partir du sous-total de la
    // commande et du taux en vigueur — jamais repris d'un corps de requête.
    const breakdown = await this.buildBreakdown(
      order.subTotal,
      order.restaurant.commissionPercent,
    );

    if (breakdown.payoutAmount <= 0) {
      throw new BadRequestException(
        'Le montant à reverser est nul. Vérifiez le sous-total de la commande et le taux de commission.',
      );
    }

    const provider = this.registry.forPayout();
    if (!provider) {
      throw new ConflictException({
        message: `Le mode ${this.registry.currentMode} ne permet pas de reverser automatiquement.`,
        code: 'PROVIDER_DOES_NOT_SUPPORT_PAYOUT',
      });
    }

    const providerPayoutId = randomUUID();

    // ── Création de la ligne, AVANT tout appel réseau ─────────────────────────
    // L'identifiant prestataire est persisté d'abord : si l'appel se perd, la
    // reprise repartira avec le MÊME identifiant, et pawaPay répondra
    // `DUPLICATE_IGNORED` au lieu de virer une seconde fois.
    let payout;
    try {
      payout = await this.prisma.restaurantPayout.create({
        data: {
          orderId: order.id,
          restaurantId: order.restaurantId,
          grossAmount: breakdown.grossAmount,
          commissionPercent: breakdown.commissionPercent,
          commissionAmount: breakdown.commissionAmount,
          amount: breakdown.payoutAmount,
          currency: 'XAF',
          phoneNumber: order.restaurant.payoutPhoneNumber!,
          providerCode: order.restaurant.payoutProvider!,
          status: PayoutStatus.PENDING,
          provider: provider.name,
          providerPayoutId,
          requestedBy: params.adminUserId,
          metadata: {
            orderRef: this.orderRef(order.id),
            vendorName: order.restaurant.nom,
          },
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Un autre administrateur a gagné la course, ou une tentative est déjà
        // en base. On ne crée rien.
        throw new ConflictException({
          message:
            'Un reversement existe déjà pour cette commande. Rechargez la fiche.',
          code: 'PAYOUT_ALREADY_COMPLETED',
        });
      }
      throw error;
    }

    this.logger.log(
      `💸 Reversement demandé — commande ${order.id}, vendeur ${order.restaurant.nom}, ` +
        `brut ${breakdown.grossAmount}, commission ${breakdown.commissionPercent}% ` +
        `(${breakdown.commissionAmount}), net ${breakdown.payoutAmount} XAF, ` +
        `tel ${maskPhone(order.restaurant.payoutPhoneNumber!)}, ` +
        `ref ${maskRef(providerPayoutId)}, par ${params.adminUserId}`,
    );

    // ── Appel au prestataire ──────────────────────────────────────────────────
    let result;
    try {
      result = await provider.createPayout({
        payoutId: payout.id,
        providerPayoutId,
        amountXaf: breakdown.payoutAmount,
        currency: 'XAF',
        phoneNumber: order.restaurant.payoutPhoneNumber!,
        payoutProvider: order.restaurant.payoutProvider!,
        orderRef: this.orderRef(order.id),
      });
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        // La ligne reste PENDING : on ne sait pas si le prestataire a reçu la
        // demande. Le cron de réconciliation tranchera, et une reprise
        // rejouerait le même identifiant.
        this.logger.error(
          `💸 Prestataire injoignable au reversement — payout ${payout.id}`,
        );
        return {
          payout: this.toPublic(payout),
          status: PayoutStatus.PENDING,
          message:
            'Demande envoyée mais non confirmée par le prestataire. Le statut sera ' +
            'mis à jour automatiquement — ne relancez pas.',
        };
      }
      throw error;
    }

    await this.events.record({
      kind: PaymentEventKind.PAYOUT,
      provider: provider.name,
      externalId: providerPayoutId,
      source: PaymentEventSource.INITIATION,
      rawStatus: result.accepted
        ? result.duplicate
          ? 'DUPLICATE_IGNORED'
          : 'ACCEPTED'
        : 'REJECTED',
      payload: result.raw,
      payoutId: payout.id,
      outcome: result.accepted
        ? PaymentEventOutcome.APPLIED
        : PaymentEventOutcome.IGNORED,
    });

    if (!result.accepted) {
      await this.markFailed(
        payout.id,
        result.failureCode,
        result.failureMessage,
      );
      const refreshed = await this.prisma.restaurantPayout.findUniqueOrThrow({
        where: { id: payout.id },
      });
      this.eventEmitter.emit('payout.failed', {
        payoutId: payout.id,
        orderId: order.id,
        restaurantId: order.restaurantId,
        ownerId: order.restaurant.ownerId,
        amount: breakdown.payoutAmount,
        reason: result.failureMessage ?? result.failureCode,
      });
      return {
        payout: this.toPublic(refreshed),
        status: PayoutStatus.FAILED,
        message:
          result.failureMessage ??
          'Le prestataire a refusé le reversement. Consultez le motif puis réessayez.',
      };
    }

    return {
      payout: this.toPublic(payout),
      status: PayoutStatus.PENDING,
      message:
        'Reversement envoyé. Le vendeur sera notifié dès confirmation du prestataire.',
    };
  }

  /**
   * Nouvelle tentative après un échec.
   *
   * L'ancienne ligne est **supprimée** dans la même transaction que la
   * vérification, plutôt que réutilisée : la contrainte `@@unique([orderId])`
   * reste ainsi intacte, et surtout le nouvel essai part avec un identifiant
   * prestataire neuf. Réutiliser un `payoutId` déjà consommé ferait répondre
   * `DUPLICATE_IGNORED` — la tentative semblerait acceptée sans que rien ne
   * parte.
   *
   * L'historique de la tentative échouée survit dans `PaymentEvent`, qui n'est
   * jamais purgé.
   */
  async retryPayout(params: { orderId: string; adminUserId: string }) {
    const existing = await this.prisma.restaurantPayout.findUnique({
      where: { orderId: params.orderId },
    });

    if (!existing) {
      throw new NotFoundException(
        'Aucun reversement à réessayer pour cette commande.',
      );
    }
    if (PAYOUT_BLOCKING_STATUSES.includes(existing.status)) {
      throw new ConflictException({
        message:
          existing.status === PayoutStatus.SUCCESS
            ? 'Ce vendeur a déjà été payé pour cette commande.'
            : 'Un reversement est déjà en cours. Attendez sa résolution.',
        code:
          existing.status === PayoutStatus.SUCCESS
            ? 'PAYOUT_ALREADY_COMPLETED'
            : 'PAYOUT_IN_PROGRESS',
      });
    }

    // Suppression conditionnée sur le statut lu : si le reversement a changé
    // d'état entre la lecture et l'écriture (réconciliation concurrente), on
    // n'efface rien.
    const deleted = await this.prisma.restaurantPayout.deleteMany({
      where: { id: existing.id, status: existing.status },
    });
    if (deleted.count === 0) {
      throw new ConflictException(
        'Le reversement a changé d’état entre-temps. Rechargez la fiche.',
      );
    }

    this.logger.log(
      `💸 Nouvelle tentative de reversement — commande ${params.orderId}, ` +
        `précédente en ${existing.status} (${existing.failureCode ?? 'sans code'})`,
    );

    return this.requestPayout(params);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Transition — point de passage unique, symétrique de l'encaissement
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Applique un statut de reversement annoncé par le prestataire.
   *
   * Appelé par le webhook de reversement **et** par le cron de réconciliation.
   * Mêmes garanties que du côté encaissement : journal écrit avant décision,
   * contrôle du montant, transition conditionnée sur `PENDING`.
   */
  async applyPayoutProviderStatus(input: {
    payoutId: string;
    status: ProviderTransactionStatus;
    source: PaymentEventSource;
  }): Promise<'APPLIED' | 'DUPLICATE' | 'IGNORED' | 'MISMATCH'> {
    const payout = await this.prisma.restaurantPayout.findUnique({
      where: { id: input.payoutId },
      include: {
        restaurant: { select: { id: true, nom: true, ownerId: true } },
      },
    });
    if (!payout) return 'IGNORED';

    const eventId = await this.events.record({
      kind: PaymentEventKind.PAYOUT,
      provider: payout.provider,
      externalId: payout.providerPayoutId ?? payout.id,
      source: input.source,
      rawStatus: input.status.rawStatus,
      payload: input.status.raw,
      payoutId: payout.id,
    });

    if (input.status.state === 'PENDING') {
      await this.events.setOutcome(eventId, PaymentEventOutcome.IGNORED);
      return 'IGNORED';
    }

    // Contrôle du montant et de la devise — un prestataire qui confirme un
    // montant différent de celui envoyé ne doit rien faire avancer.
    const mismatch = this.detectMismatch(payout, input.status);
    if (mismatch) {
      await this.events.setOutcome(eventId, PaymentEventOutcome.MISMATCH);
      this.logger.error(
        `🚨 [REVERSEMENT] Incohérence — payout ${payout.id}, ${mismatch}`,
      );
      Sentry.captureMessage(
        `payout.mismatch — reversement ${payout.id} : ${mismatch}`,
        'error',
      );
      await this.openMismatchIncident(payout.id, payout.orderId, mismatch);
      return 'MISMATCH';
    }

    const target =
      input.status.state === 'SUCCESS'
        ? PayoutStatus.SUCCESS
        : PayoutStatus.FAILED;
    this.stateMachine.assertTransition(PayoutStatus.PENDING, target);

    const claimed = await this.prisma.restaurantPayout.updateMany({
      where: { id: payout.id, status: PayoutStatus.PENDING },
      data: {
        status: target,
        completedAt: new Date(),
        providerTransactionId: input.status.providerTransactionId ?? null,
        failureCode:
          target === PayoutStatus.FAILED
            ? (input.status.failureCode ?? null)
            : null,
        failureMessage:
          target === PayoutStatus.FAILED
            ? (input.status.failureMessage ?? null)
            : null,
      },
    });

    if (claimed.count === 0) {
      // Rejeu, ou callback hors ordre : le premier statut terminal a gagné.
      await this.events.setOutcome(eventId, PaymentEventOutcome.DUPLICATE);
      return 'DUPLICATE';
    }

    await this.events.setOutcome(eventId, PaymentEventOutcome.APPLIED);

    if (target === PayoutStatus.SUCCESS) {
      this.logger.log(
        `💸 [REVERSEMENT] ✅ ${payout.amount} XAF versés à ${payout.restaurant.nom} ` +
          `(commande ${payout.orderId})`,
      );
      this.eventEmitter.emit('payout.succeeded', {
        payoutId: payout.id,
        orderId: payout.orderId,
        restaurantId: payout.restaurantId,
        ownerId: payout.restaurant.ownerId,
        amount: payout.amount,
      });
    } else {
      this.logger.warn(
        `💸 [REVERSEMENT] ❌ Échec — payout ${payout.id}, code ${input.status.failureCode ?? 'n/a'}`,
      );
      this.eventEmitter.emit('payout.failed', {
        payoutId: payout.id,
        orderId: payout.orderId,
        restaurantId: payout.restaurantId,
        ownerId: payout.restaurant.ownerId,
        amount: payout.amount,
        reason: input.status.failureMessage ?? input.status.failureCode,
      });
    }

    return 'APPLIED';
  }

  private detectMismatch(
    payout: { amount: number; currency: string },
    status: ProviderTransactionStatus,
  ): string | null {
    if (status.currency && status.currency !== payout.currency) {
      return `devise attendue ${payout.currency}, reçue ${status.currency}`;
    }
    if (status.amountXaf === undefined) return null;
    const expected = Math.round(payout.amount);
    if (Math.abs(status.amountXaf - expected) > 1) {
      return `montant attendu ${expected}, reçu ${status.amountXaf}`;
    }
    return null;
  }

  private async openMismatchIncident(
    payoutId: string,
    orderId: string,
    detail: string,
  ) {
    await this.prisma.incident
      .create({
        data: {
          type: 'OTHER',
          severity: 'CRITICAL',
          title: 'Incohérence de montant sur un reversement vendeur',
          description:
            `Le prestataire a annoncé un statut terminal avec un montant ou une devise ` +
            `différents de ceux envoyés (${detail}). Aucune transition n'a été appliquée.`,
          orderId,
          metadata: { payoutId, detail },
        },
      })
      .catch((error) =>
        this.logger.error(
          `Incident de reversement non créé : ${(error as Error).message}`,
        ),
      );
  }

  private async markFailed(
    payoutId: string,
    failureCode?: string,
    failureMessage?: string,
  ): Promise<boolean> {
    const claimed = await this.prisma.restaurantPayout.updateMany({
      where: { id: payoutId, status: PayoutStatus.PENDING },
      data: {
        status: PayoutStatus.FAILED,
        completedAt: new Date(),
        failureCode: failureCode ?? null,
        failureMessage: failureMessage ?? null,
      },
    });
    return claimed.count > 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Lecture
  // ══════════════════════════════════════════════════════════════════════════

  async findByOrder(orderId: string) {
    return this.prisma.restaurantPayout.findUnique({ where: { orderId } });
  }

  async findByProviderPayoutId(provider: string, externalId: string) {
    return this.prisma.restaurantPayout.findFirst({
      where: { provider, providerPayoutId: externalId },
    });
  }

  /** File d'administration : reversements filtrables par statut. */
  async list(params: {
    status?: PayoutStatus;
    restaurantId?: string;
    page?: number;
    limit?: number;
  }) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const where: Prisma.RestaurantPayoutWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.restaurantPayout.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          restaurant: { select: { id: true, nom: true, vendorType: true } },
          order: {
            select: { id: true, status: true, subTotal: true, total: true },
          },
        },
      }),
      this.prisma.restaurantPayout.count({ where }),
    ]);

    return { data: rows, meta: { page, limit, total } };
  }

  /**
   * Récapitulatif financier complet d'une commande.
   *
   * Sépare explicitement les quatre flux, parce que les confondre est
   * précisément ce qu'on cherche à empêcher :
   *  · ce que paie le client ;
   *  · ce que touche le vendeur ;
   *  · ce que garde Lilia Food ;
   *  · ce que coûte le prestataire (charge de Lilia Food, jamais répercutée).
   */
  async getOrderFinancials(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        restaurant: {
          select: {
            id: true,
            nom: true,
            commissionPercent: true,
            payoutPhoneNumber: true,
            payoutProvider: true,
            payoutAccountName: true,
          },
        },
        Payment: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            amount: true,
            currency: true,
            provider: true,
            method: true,
            collectionFeeXaf: true,
            failureCode: true,
            failureMessage: true,
            completedAt: true,
            createdAt: true,
          },
        },
        payout: true,
        refund: { select: { id: true, status: true, amount: true } },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');

    const eligibility = await this.checkEligibility(orderId);
    const collection =
      order.Payment.find((p) => p.status === PaymentStatus.SUCCESS) ??
      order.Payment[0] ??
      null;

    // Décompte prévisionnel tant qu'aucun reversement n'existe ; snapshot figé
    // dès qu'il existe. Ne JAMAIS recalculer un reversement passé : son taux
    // peut différer du taux courant, et c'est celui-là qui fait foi.
    const breakdown = order.payout
      ? {
          grossAmount: order.payout.grossAmount,
          commissionPercent: order.payout.commissionPercent,
          commissionAmount: order.payout.commissionAmount,
          payoutAmount: order.payout.amount,
        }
      : await this.buildBreakdown(
          order.subTotal,
          order.restaurant.commissionPercent,
        );

    const collectionFee = collection?.collectionFeeXaf ?? null;
    const payoutFee = order.payout?.payoutFeeXaf ?? null;

    return {
      orderId: order.id,
      orderRef: this.orderRef(order.id),
      orderStatus: order.status,

      client: {
        subTotal: order.subTotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        discountAmount: order.discountAmount,
        totalPaid: order.total,
        currency: 'XAF',
        collection: collection
          ? {
              paymentId: collection.id,
              status: collection.status,
              provider: collection.provider,
              method: collection.method,
              amount: collection.amount,
              completedAt: collection.completedAt,
              failureCode: collection.failureCode,
              failureMessage: collection.failureMessage,
            }
          : null,
      },

      restaurant: {
        id: order.restaurant.id,
        nom: order.restaurant.nom,
        grossAmount: breakdown.grossAmount,
        commissionPercent: breakdown.commissionPercent,
        commissionAmount: breakdown.commissionAmount,
        payoutAmount: breakdown.payoutAmount,
        payoutAccount: {
          phoneNumber: order.restaurant.payoutPhoneNumber
            ? maskPhone(order.restaurant.payoutPhoneNumber)
            : null,
          provider: order.restaurant.payoutProvider,
          accountName: order.restaurant.payoutAccountName,
          configured: Boolean(
            order.restaurant.payoutPhoneNumber &&
            order.restaurant.payoutProvider,
          ),
        },
        payout: order.payout
          ? {
              id: order.payout.id,
              status: order.payout.status,
              amount: order.payout.amount,
              requestedBy: order.payout.requestedBy,
              requestedAt: order.payout.requestedAt,
              completedAt: order.payout.completedAt,
              failureCode: order.payout.failureCode,
              failureMessage: order.payout.failureMessage,
              provider: order.payout.provider,
            }
          : null,
        // ⚠️ SEUL `SUCCESS` vaut « payé ». Un reversement PENDING n'est pas de
        // l'argent reçu, et un FAILED encore moins.
        paid: order.payout?.status === PayoutStatus.SUCCESS,
      },

      liliaFood: {
        serviceFee: order.serviceFee,
        restaurantCommission: breakdown.commissionAmount,
        collectionFee,
        payoutFee,
        // Marge nette connue seulement quand les deux frais prestataire le sont.
        netMargin:
          collectionFee !== null && payoutFee !== null
            ? order.serviceFee +
              breakdown.commissionAmount -
              collectionFee -
              payoutFee
            : null,
        currency: 'XAF',
      },

      refund: order.refund,
      eligibility,
    };
  }

  private toPublic(payout: {
    id: string;
    orderId: string;
    restaurantId: string;
    grossAmount: number;
    commissionPercent: number;
    commissionAmount: number;
    amount: number;
    currency: string;
    status: PayoutStatus;
    provider: string;
    failureCode: string | null;
    failureMessage: string | null;
    requestedBy: string;
    requestedAt: Date;
    completedAt: Date | null;
  }) {
    return {
      id: payout.id,
      orderId: payout.orderId,
      restaurantId: payout.restaurantId,
      grossAmount: payout.grossAmount,
      commissionPercent: payout.commissionPercent,
      commissionAmount: payout.commissionAmount,
      amount: payout.amount,
      currency: payout.currency,
      status: payout.status,
      provider: payout.provider,
      failureCode: payout.failureCode,
      failureMessage: payout.failureMessage,
      requestedBy: payout.requestedBy,
      requestedAt: payout.requestedAt,
      completedAt: payout.completedAt,
    };
  }

  private orderRef(orderId: string): string {
    return orderId.slice(-6).toUpperCase();
  }
}
