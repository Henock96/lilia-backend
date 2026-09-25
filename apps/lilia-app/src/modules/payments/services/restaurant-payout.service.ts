import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  OrderStatus,
  PayoutProvider,
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  PayoutStatus,
  Prisma,
  RefundBearer,
  RefundReasonCode,
  RefundStatus,
} from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../../prisma/prisma.service';
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
import { lockOrderRow } from '../../orders/order-row-lock';
import { maskPhone, maskRef, PaymentStatus } from './payment.service';
import {
  IN_FLIGHT_REFUND_STATUSES,
  refundConflictsWithPayout,
} from '../../refunds/refund-lines.policy';
import { OutboxService } from '../../outbox/outbox.service';
import {
  PAYOUT_FAILED_EVENT,
  PAYOUT_SUCCEEDED_EVENT,
} from '../../outbox/outbox-events';
import {
  lockRestaurantRow,
  recordDebtSettled,
  restoreDebtOfFailedPayout,
  vendorDebtXaf,
} from '../vendor-balance';

/** Qui a déclenché un versement : un administrateur, ou le worker (F3-07). */
export type PayoutTrigger = 'MANUAL' | 'AUTO';

/**
 * Prestataire d'un versement entièrement absorbé par la dette du vendeur :
 * aucun argent ne part, aucun appel au prestataire (F3-07).
 */
export const NETTING_PROVIDER = 'NETTING';

/** Ce qu'un reversement doit savoir des remboursements de sa commande. */
export interface PayoutRefundView {
  status: RefundStatus;
  bearer: RefundBearer;
  reasonCode: RefundReasonCode;
  amount: number;
}

/**
 * Remboursements × reversement vendeur (F3-06).
 *
 *  - un remboursement **en vol** qui touche au vendeur (à sa charge, ou sur une
 *    commande qu'il ne devait pas être payé) bloque le reversement : son montant
 *    n'est pas encore fixé ;
 *  - les remboursements **versés** à sa charge sont retenus sur le virement.
 *
 * Un geste de la plateforme ne touche pas au vendeur : ni blocage, ni retenue.
 * C'est aussi ce qui laisse payer le vendeur d'une livraison échouée dont il
 * ne répond pas (F3-05) pendant que le client est remboursé.
 */
export function refundGateForPayout(refunds: PayoutRefundView[]): {
  blocked: boolean;
  deductionXaf: number;
} {
  return {
    blocked: refunds.some(
      (r) =>
        IN_FLIGHT_REFUND_STATUSES.includes(r.status) &&
        refundConflictsWithPayout(r),
    ),
    deductionXaf: refunds
      .filter(
        (r) =>
          r.status === RefundStatus.COMPLETED &&
          r.bearer === RefundBearer.VENDOR,
      )
      .reduce((sum, r) => sum + r.amount, 0),
  };
}

const PAYOUT_REFUND_SELECT = {
  status: true,
  bearer: true,
  reasonCode: true,
  amount: true,
} as const;

/**
 * Statuts de commande à partir desquels un vendeur peut être reversé.
 *
 * **`LIVRER` seulement** depuis F3-07 (décision D5, 25/09/2026). Le seuil était
 * `PRET` : un vendeur payé avant la remise devait être repris dans à peu près
 * tous les échecs, et c'est ce qui faisait exister toute la classe F-04 (payé
 * sur une commande ensuite annulée). `LIVRER` est terminal : une commande
 * payée au vendeur ne peut plus être annulée.
 *
 * Plus un cas : un échec de livraison conclu dont le vendeur ne répond pas
 * (F3-05), traité à part dans `checkEligibility`.
 *
 * Le versement AUTOMATIQUE exige en plus une preuve de remise fiable et son
 * échéance (`Order.payoutDueAt`) ; le versement manuel, décision d'un
 * administrateur, n'attend pas l'échéance.
 */
export const PAYOUT_ELIGIBLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.LIVRER,
];

/** Motifs de non-éligibilité, destinés à l'affichage dans l'administration. */
export type PayoutIneligibilityCode =
  | 'ORDER_NOT_FOUND'
  | 'ORDER_CANCELLED'
  | 'ORDER_NOT_READY'
  | 'PAYMENT_NOT_COMPLETED'
  | 'ORDER_REFUNDED'
  | 'ORDER_FAILED_VENDOR_LIABLE'
  | 'VENDOR_PAYOUT_ACCOUNT_MISSING'
  | 'VENDOR_PAYOUT_ACCOUNT_COOLING_DOWN'
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
    refundDeductionAmount?: number;
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
    // ⚠️ `PlatformSettingsService` a été RETIRÉ de ce service le 17/09/2026.
    // Il n'y servait qu'au repli de commission, désormais résolu au checkout.
    // Le réintroduire ici ferait resurgir le défaut : un taux courant qui
    // réécrit ce que la plateforme prélève sur une commande déjà passée.
    private readonly events: PaymentEventService,
    private readonly stateMachine: PayoutStateMachine,
    // F3-07 — les notifications de versement passent par l'outbox, écrites
    // avec la transition. Un `EventEmitter` ne portait rien quand c'est le
    // worker (réconciliation, versement automatique) qui concluait : il n'y a
    // aucun écouteur dans ce processus.
    private readonly outbox: OutboxService,
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
            payoutVerifiedAt: true,
          },
        },
        Payment: { select: { status: true, amount: true } },
        refunds: { select: PAYOUT_REFUND_SELECT },
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

    const refundGate = refundGateForPayout(order.refunds);
    const breakdown = this.buildBreakdown(
      order.subTotal,
      order.commissionPercent,
      order.vendorDeliverySubsidyXaf,
      refundGate.deductionXaf,
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
    // F3-05 — échec de livraison conclu : le vendeur est payé sauf s'il en
    // est responsable (R-05.3).
    const failed = order.status === OrderStatus.ECHEC_LIVRAISON;
    if (failed && order.failureLiability === 'VENDOR') {
      return withBreakdown({
        eligible: false,
        code: 'ORDER_FAILED_VENDOR_LIABLE',
        reason:
          "L'échec de livraison a été imputé au vendeur : il n'est pas payé pour cette commande.",
      });
    }
    if (!failed && !PAYOUT_ELIGIBLE_ORDER_STATUSES.includes(order.status)) {
      return withBreakdown({
        eligible: false,
        code: 'ORDER_NOT_READY',
        reason:
          `La commande est au statut ${order.status}. Le vendeur est payé une ` +
          `fois la commande remise au client (« LIVRER »).`,
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

    // Un remboursement en vol qui touche au vendeur : son montant n'est pas
    // encore fixé, et reverser maintenant, c'est payer ce qui sera peut-être
    // retenu. Un geste de la plateforme — ou le remboursement d'un échec dont
    // le vendeur ne répond pas (F3-05) — ne retient rien : pas de blocage
    // (`refundGateForPayout`).
    if (refundGate.blocked) {
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

    const coolingUntil = payoutAccountCoolingUntil(
      order.restaurant.payoutVerifiedAt,
      new Date(),
    );
    if (coolingUntil) {
      return withBreakdown({
        eligible: false,
        code: 'VENDOR_PAYOUT_ACCOUNT_COOLING_DOWN',
        reason: payoutCoolingMessage(coolingUntil),
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
   * Décompte du reversement, à partir du taux **figé sur la commande**.
   *
   * ## Pourquoi le taux ne se résout pas ici
   *
   * Cette méthode lisait auparavant `Restaurant.commissionPercent`, et
   * retombait sur `PlatformSettings.restaurantCommissionPercent` quand le
   * vendeur n'en portait pas. Deux conséquences, toutes deux fausses :
   *
   * 1. **Le passé bougeait.** Un taux modifié aujourd'hui réécrivait ce que la
   *    plateforme prélèverait sur une commande d'hier pas encore reversée. Un
   *    chiffre comptable ne se recalcule pas — c'est exactement la raison
   *    d'être de `OrderItem.snapshotPrice` et de `Order.commissionPercent`.
   * 2. **Deux replis contradictoires coexistaient.** Le checkout retombait sur
   *    `0`, ce reversement sur le taux plateforme. En production au 17/09/2026,
   *    les 124 commandes portaient donc `commissionPercent = 0` pendant que les
   *    reversements prélevaient 10 %. La commande disait une chose, le virement
   *    en faisait une autre.
   *
   * Le repli n'a pas disparu : il a été ramené à l'unique endroit où il a un
   * sens — le checkout (`OrderCheckoutService`), qui résout
   * « taux du vendeur, sinon taux plateforme » **une fois** et fige le résultat.
   * Ici, on lit ce qui a été figé. Un seul résolveur, un seul repli.
   *
   * ⚠️ Ne jamais réintroduire de lecture de `Restaurant.commissionPercent` dans
   * ce service : le taux d'un vendeur décrit ses commandes **futures**.
   */
  private buildBreakdown(
    subTotal: number,
    orderCommissionPercent: number,
    // F3-02 : part de la course offerte par le vendeur, figée à la commande.
    // Absente des lignes antérieures (défaut 0 en base).
    vendorDeliverySubsidyXaf: number | null | undefined,
    // F3-06 : remboursements versés à la charge du vendeur.
    refundDeductionXaf = 0,
  ) {
    return computePayoutBreakdown({
      subTotalXaf: toXaf(subTotal, 'sous-total'),
      commissionPercent: orderCommissionPercent,
      deliverySubsidyXaf: vendorDeliverySubsidyXaf ?? 0,
      refundDeductionXaf,
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
  async requestPayout(params: {
    orderId: string;
    /** `null` = versement automatique (F3-07). */
    adminUserId: string | null;
    trigger?: PayoutTrigger;
  }) {
    const trigger: PayoutTrigger = params.trigger ?? 'MANUAL';
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
        refunds: { select: PAYOUT_REFUND_SELECT },
      },
    });

    // Le décompte est reconstruit ici, côté serveur, à partir du sous-total ET
    // du taux figés sur la commande — jamais repris d'un corps de requête, et
    // jamais relu sur la fiche du vendeur (qui décrit ses commandes futures).
    const breakdown = this.buildBreakdown(
      order.subTotal,
      order.commissionPercent,
      order.vendorDeliverySubsidyXaf,
      refundGateForPayout(order.refunds).deductionXaf,
    );

    if (breakdown.payoutAmount <= 0) {
      throw new BadRequestException(
        'Le montant à reverser est nul. Vérifiez le sous-total de la commande, le taux de commission et la part de livraison offerte par le vendeur.',
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
    //
    // ⚠️ Fix F-04 (Master Audit v1) — la ligne naît SOUS le verrou de la
    // commande. `checkEligibility` ci-dessus a été évalué hors transaction :
    // entre cette lecture et l'insertion, un vendeur ou un admin pouvait
    // annuler la commande, et un remboursement s'ouvrir — le vendeur était
    // alors payé d'une commande remboursée au client. Les conditions qui
    // engagent de l'argent sont donc revérifiées ici, verrou tenu ; une
    // annulation concurrente attend notre commit, puis voit le reversement
    // (et la refuse au vendeur, cf. `OrderLifecycleService`).
    let payout;
    try {
      payout = await this.prisma.$transaction(async (tx) => {
        const locked = await lockOrderRow(tx, order.id);
        // F3-05 — un échec conclu reste payable au vendeur s'il n'en répond
        // pas. Cette relecture sous verrou l'oubliait : `checkEligibility`
        // disait « éligible », le virement répondait « pas prête ».
        const failedPayable =
          locked?.status === OrderStatus.ECHEC_LIVRAISON &&
          (
            await tx.order.findUniqueOrThrow({
              where: { id: order.id },
              select: { failureLiability: true },
            })
          ).failureLiability !== 'VENDOR';
        if (
          !locked ||
          (!failedPayable &&
            !PAYOUT_ELIGIBLE_ORDER_STATUSES.includes(locked.status))
        ) {
          throw new ConflictException({
            message:
              locked?.status === OrderStatus.ANNULER
                ? 'Cette commande vient d’être annulée : aucun reversement.'
                : 'Le statut de la commande a changé. Rechargez la fiche.',
            code:
              locked?.status === OrderStatus.ANNULER
                ? 'ORDER_CANCELLED'
                : 'ORDER_NOT_READY',
          });
        }
        // F3-06 — les remboursements relus sous verrou : un remboursement à la
        // charge du vendeur ouvert (ou versé) depuis la lecture ci-dessus
        // changerait ce qui lui revient.
        const lockedGate = refundGateForPayout(
          await tx.refund.findMany({
            where: { orderId: order.id },
            select: PAYOUT_REFUND_SELECT,
          }),
        );
        if (lockedGate.blocked) {
          throw new ConflictException({
            message:
              'Un remboursement est ouvert sur cette commande. Traitez-le avant de payer le vendeur.',
            code: 'ORDER_REFUNDED',
          });
        }
        if (lockedGate.deductionXaf !== breakdown.refundDeductionAmount) {
          throw new ConflictException({
            message:
              'Un remboursement vient de modifier ce qui revient au vendeur. Rechargez la fiche.',
            code: 'ORDER_REFUNDED',
          });
        }
        // Fix F-08 — le compte de reversement est RELU sous verrou : c'est lui
        // qui reçoit l'argent, et il a pu changer depuis la lecture ci-dessus.
        // Un numéro saisi il y a moins de `PAYOUT_ACCOUNT_COOLDOWN_HOURS` ne
        // reçoit rien : un compte administrateur compromis qui remplace le
        // numéro d'un vendeur puis déclenche aussitôt le virement est arrêté,
        // et le vendeur — prévenu du changement — a le temps de réagir.
        const account = await tx.restaurant.findUniqueOrThrow({
          where: { id: order.restaurantId },
          select: {
            payoutPhoneNumber: true,
            payoutProvider: true,
            payoutVerifiedAt: true,
          },
        });
        if (!account.payoutPhoneNumber || !account.payoutProvider) {
          throw new ConflictException({
            message:
              'Aucun compte Mobile Money de reversement configuré pour ce vendeur.',
            code: 'VENDOR_PAYOUT_ACCOUNT_MISSING',
          });
        }
        const cooling = payoutAccountCoolingUntil(
          account.payoutVerifiedAt,
          new Date(),
        );
        if (cooling) {
          throw new ConflictException({
            message: payoutCoolingMessage(cooling),
            code: 'VENDOR_PAYOUT_ACCOUNT_COOLING_DOWN',
          });
        }
        // F3-07 — dette du vendeur (remboursements survenus après un
        // versement précédent), retenue ici. Verrou du vendeur APRÈS celui de
        // la commande (R3) : deux versements simultanés ne retiennent pas
        // deux fois la même dette.
        await lockRestaurantRow(tx, order.restaurantId);
        const debtDeduction = Math.min(
          await vendorDebtXaf(tx, order.restaurantId),
          breakdown.payoutAmount,
        );
        const net = breakdown.payoutAmount - debtDeduction;
        // Tout est absorbé par la dette : rien ne part chez le prestataire.
        const netting = net === 0;

        const created = await tx.restaurantPayout.create({
          data: {
            orderId: order.id,
            restaurantId: order.restaurantId,
            grossAmount: breakdown.grossAmount,
            commissionPercent: breakdown.commissionPercent,
            commissionAmount: breakdown.commissionAmount,
            deliverySubsidyAmount: breakdown.deliverySubsidyAmount,
            refundDeductionAmount: breakdown.refundDeductionAmount,
            debtDeductionAmount: debtDeduction,
            amount: net,
            currency: 'XAF',
            phoneNumber: account.payoutPhoneNumber,
            providerCode: account.payoutProvider,
            status: netting ? PayoutStatus.SUCCESS : PayoutStatus.PENDING,
            completedAt: netting ? new Date() : null,
            provider: netting ? NETTING_PROVIDER : provider.name,
            providerPayoutId: netting ? null : providerPayoutId,
            requestedBy: params.adminUserId,
            metadata: {
              orderRef: this.orderRef(order.id),
              vendorName: order.restaurant.nom,
              trigger,
            },
          },
        });
        await recordDebtSettled(tx, {
          restaurantId: order.restaurantId,
          payoutId: created.id,
          orderId: order.id,
          amountXaf: debtDeduction,
        });
        if (netting) {
          await this.enqueuePayoutEvent(tx, PAYOUT_SUCCEEDED_EVENT, {
            payoutId: created.id,
            orderId: order.id,
            restaurantId: order.restaurantId,
            ownerId: order.restaurant.ownerId,
            amount: 0,
            debtDeductionAmount: debtDeduction,
          });
        }
        return created;
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
        `(${breakdown.commissionAmount}), livraison offerte ${breakdown.deliverySubsidyAmount}, ` +
        `retenue remboursements ${breakdown.refundDeductionAmount}, ` +
        `retenue dette ${payout.debtDeductionAmount}, ` +
        `net ${payout.amount} XAF, ` +
        `tel ${maskPhone(payout.phoneNumber)}, ` +
        `ref ${maskRef(providerPayoutId)}, ${trigger === 'AUTO' ? 'automatique' : `par ${params.adminUserId}`}`,
    );

    if (payout.provider === NETTING_PROVIDER) {
      return {
        payout: this.toPublic(payout),
        status: PayoutStatus.SUCCESS,
        message:
          'Rien à verser : la somme due au vendeur couvre une dette de remboursement. Aucun virement n’est parti.',
      };
    }

    // ── Appel au prestataire ──────────────────────────────────────────────────
    let result;
    try {
      result = await provider.createPayout({
        payoutId: payout.id,
        providerPayoutId,
        amountXaf: payout.amount,
        currency: 'XAF',
        // Le compte relu sous verrou, figé sur la ligne — pas la lecture
        // d'avant la transaction.
        phoneNumber: payout.phoneNumber,
        payoutProvider: payout.providerCode as PayoutProvider,
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
        payout,
        result.failureCode,
        result.failureMessage,
        order.restaurant.ownerId,
      );
      const refreshed = await this.prisma.restaurantPayout.findUniqueOrThrow({
        where: { id: payout.id },
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

    // F3-07 — la transition, la dette rendue d'un échec et la notification
    // due au vendeur sont écrites ensemble : le worker qui réconcilie n'a pas
    // d'écouteur, un événement en mémoire s'y perdait.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.restaurantPayout.updateMany({
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
      if (moved.count === 0) return moved;
      if (target === PayoutStatus.FAILED) {
        await restoreDebtOfFailedPayout(tx, payout);
      }
      await this.enqueuePayoutEvent(
        tx,
        target === PayoutStatus.SUCCESS
          ? PAYOUT_SUCCEEDED_EVENT
          : PAYOUT_FAILED_EVENT,
        {
          payoutId: payout.id,
          orderId: payout.orderId,
          restaurantId: payout.restaurantId,
          ownerId: payout.restaurant.ownerId,
          amount: payout.amount,
          debtDeductionAmount: payout.debtDeductionAmount,
          ...(target === PayoutStatus.FAILED
            ? {
                reason:
                  input.status.failureMessage ??
                  input.status.failureCode ??
                  null,
              }
            : {}),
        },
      );
      return moved;
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
      await this.flagPaidOnCancelledOrder(payout);
    } else {
      this.logger.warn(
        `💸 [REVERSEMENT] ❌ Échec — payout ${payout.id}, code ${input.status.failureCode ?? 'n/a'}`,
      );
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

  /**
   * Un reversement confirmé sur une commande annulée entre-temps (F-04).
   *
   * C'est le seul chemin restant : un ADMIN peut annuler une commande dont le
   * reversement est déjà parti chez le prestataire (un virement émis ne se
   * rappelle pas). Le vendeur est alors payé ET le client a un remboursement
   * ouvert — que `RefundExecutionService` refuse d'exécuter tant que le
   * reversement est PENDING ou SUCCESS. Ce n'est pas un bug à cacher, c'est
   * une décision financière à prendre : on l'inscrit dans la file des
   * incidents, où elle ne peut pas être oubliée.
   */
  private async flagPaidOnCancelledOrder(payout: {
    id: string;
    orderId: string;
    amount: number;
  }): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: payout.orderId },
      select: { status: true },
    });
    if (order?.status !== OrderStatus.ANNULER) return;

    this.logger.error(
      `🚨 [REVERSEMENT] Vendeur payé sur une commande annulée — payout ${payout.id}, commande ${payout.orderId}`,
    );
    Sentry.captureMessage(
      `payout.on_cancelled_order — reversement ${payout.id}, commande ${payout.orderId}`,
      'error',
    );
    await this.prisma.incident
      .create({
        data: {
          type: 'REFUND_REQUEST',
          severity: 'CRITICAL',
          title: 'Vendeur payé sur une commande annulée',
          description:
            `Le reversement de ${payout.amount} FCFA a abouti alors que la commande a été ` +
            `annulée pendant qu'il était en cours. Le remboursement du client est bloqué ` +
            `tant que cet arbitrage n'est pas fait : récupérer la somme auprès du vendeur, ` +
            `ou rembourser le client à la charge de Lilia Food.`,
          orderId: payout.orderId,
          metadata: { payoutId: payout.id, amount: payout.amount },
        },
      })
      .catch((error) =>
        this.logger.error(
          `Incident « payé sur annulée » non créé : ${(error as Error).message}`,
        ),
      );
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

  /** Refus du prestataire à l'émission : échec, dette rendue, vendeur prévenu. */
  private async markFailed(
    payout: {
      id: string;
      orderId: string;
      restaurantId: string;
      amount: number;
      debtDeductionAmount: number;
    },
    failureCode: string | undefined,
    failureMessage: string | undefined,
    ownerId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.restaurantPayout.updateMany({
        where: { id: payout.id, status: PayoutStatus.PENDING },
        data: {
          status: PayoutStatus.FAILED,
          completedAt: new Date(),
          failureCode: failureCode ?? null,
          failureMessage: failureMessage ?? null,
        },
      });
      if (claimed.count === 0) return false;
      await restoreDebtOfFailedPayout(tx, payout);
      await this.enqueuePayoutEvent(tx, PAYOUT_FAILED_EVENT, {
        payoutId: payout.id,
        orderId: payout.orderId,
        restaurantId: payout.restaurantId,
        ownerId,
        amount: payout.amount,
        debtDeductionAmount: payout.debtDeductionAmount,
        reason: failureMessage ?? failureCode ?? null,
      });
      return true;
    });
  }

  private async enqueuePayoutEvent(
    tx: Prisma.TransactionClient,
    type: typeof PAYOUT_SUCCEEDED_EVENT | typeof PAYOUT_FAILED_EVENT,
    payload: {
      payoutId: string;
      orderId: string;
      restaurantId: string;
      ownerId: string;
      amount: number;
      debtDeductionAmount: number;
      reason?: string | null;
    },
  ): Promise<void> {
    await this.outbox.enqueueInTransaction(tx, {
      type,
      aggregateId: payload.payoutId,
      payload,
    });
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
        refunds: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            status: true,
            amount: true,
            bearer: true,
            reasonCode: true,
            incidentId: true,
            createdAt: true,
            processedAt: true,
          },
        },
        // Snapshot économique de la course. On ne sélectionne QUE l'économie :
        // la position GPS et les horodatages n'ont rien à faire dans un
        // récapitulatif financier, et les charger inviterait à les y afficher.
        delivery: {
          select: {
            driverBaseXaf: true,
            driverPayXaf: true,
            driverSharePercent: true,
            driverEmploymentType: true,
            driverCompensationModel: true,
            driverEconomicsFrozenAt: true,
          },
        },
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
          deliverySubsidyAmount: order.payout.deliverySubsidyAmount,
          refundDeductionAmount: order.payout.refundDeductionAmount,
          debtDeductionAmount: order.payout.debtDeductionAmount,
          payoutAmount: order.payout.amount,
        }
      : this.buildBreakdown(
          order.subTotal,
          order.commissionPercent,
          order.vendorDeliverySubsidyXaf,
          refundGateForPayout(order.refunds).deductionXaf,
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
        deliverySubsidyAmount: breakdown.deliverySubsidyAmount,
        refundDeductionAmount: breakdown.refundDeductionAmount,
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

      liliaFood: this.buildContribution(order, breakdown, {
        collectionFee,
        payoutFee,
      }),

      // F3-06 — N remboursements par commande. `refund` (le plus récent) reste
      // pour les écrans antérieurs, qui n'en connaissaient qu'un.
      refunds: order.refunds,
      refund: order.refunds[order.refunds.length - 1] ?? null,
      refundedXaf: order.refunds
        .filter((r) => r.status !== RefundStatus.REJECTED)
        .reduce((sum, r) => sum + r.amount, 0),
      eligibility,
    };
  }

  /**
   * Ce que Lilia Food gagne réellement sur une commande.
   *
   * ## Ce que le calcul précédent disait, et pourquoi c'était faux
   *
   * ```ts
   * netMargin = serviceFee + commission − collectionFee − payoutFee
   * ```
   *
   * Ce nombre était affiché sous le libellé « Marge nette » dans les deux
   * back-offices. Il omettait **trois** postes connus, dont deux de sens
   * opposé — l'erreur ne se compensait donc pas, et son ampleur variait d'une
   * commande à l'autre :
   *
   * | Poste | Qui le paie / le reçoit | Dans le reversement vendeur ? | Effet |
   * |---|---|---|---|
   * | `deliveryFee` | le client | **non** (`grossAmount = subTotal`) | **revenu** omis |
   * | `discountAmount` | Lilia (promo + fidélité) | **non** (payout sur `subTotal` brut) | **coût** omis |
   * | `Refund` `COMPLETED` | Lilia, rendu au client | non | **coût** omis |
   *
   * Sur le panier type observé en production (sous-total 4 000, livraison
   * 1 000, frais de service 320, commission 400, frais prestataire ~195),
   * l'ancien calcul affichait 525 XAF là où le revenu réel avant course est de
   * 1 525 XAF.
   *
   * ## Pourquoi la contribution est `null` sur une commande livrée
   *
   * Le **coût du livreur n'existe nulle part dans le système** — ni colonne, ni
   * table, ni règle métier (vérifié sur tout le dépôt et toute la
   * documentation). C'est le poste de coût variable principal d'une
   * marketplace de livraison.
   *
   * On ne le remplace **pas** par zéro : écrire `driverCost = 0` transformerait
   * « inconnu » en « gratuit » et produirait une marge systématiquement
   * surestimée, avec l'air d'être exacte. `null` + `missingInputs` dit ce qui
   * manque, et le dit à l'écran.
   *
   * Sur une commande **à emporter**, il n'y a pas de livreur : la contribution
   * est alors calculable — *à condition que les frais du prestataire soient
   * connus*.
   *
   * ⚠️ Ils ne le sont pas. `Payment.collectionFeeXaf` et
   * `RestaurantPayout.payoutFeeXaf` sont **lus ici et écrits nulle part**
   * (vérifié sur tout le dépôt). Mesuré en production le 16/09/2026 :
   * 0 / 61 paiements et 0 / 2 reversements portent une valeur. En pratique,
   * `missingInputs` n'est donc **jamais vide** et `contributionMargin` vaut
   * `null` sur 100 % des commandes, retraits au comptoir compris.
   *
   * Ce n'est pas un défaut de ce calcul — il dit exactement ce qu'il sait — mais
   * il faut le savoir avant de conclure que « la marge ne s'affiche pas » vient
   * du coût livreur seul. Alimenter ces deux colonnes depuis les callbacks
   * pawaPay est un chantier distinct, hors périmètre de la phase 1E.
   */
  private buildContribution(
    order: {
      deliveryFee: number;
      serviceFee: number;
      discountAmount: number;
      loyaltyDiscount: number;
      isDelivery: boolean;
      refunds: { status: RefundStatus; amount: number }[];
      /**
       * Snapshot économique de la course. `null` quand aucune course n'existe
       * (retrait au comptoir, ou livraison faite hors système — 7 commandes en
       * production).
       */
      delivery: {
        driverBaseXaf: number | null;
        driverPayXaf: number | null;
        driverSharePercent: number | null;
        driverEmploymentType: string | null;
        driverCompensationModel: string | null;
        driverEconomicsFrozenAt: Date | null;
      } | null;
    },
    breakdown: {
      commissionAmount: number;
      deliverySubsidyAmount?: number;
      refundDeductionAmount?: number;
    },
    fees: { collectionFee: number | null; payoutFee: number | null },
  ) {
    const { collectionFee, payoutFee } = fees;

    // ── Revenus ───────────────────────────────────────────────────────────
    // Les frais de livraison encaissés sont un revenu de Lilia : le client les
    // paie, le vendeur ne les reçoit pas (`grossAmount = subTotal`). Ce qu'ils
    // coûtent réellement — la course — est le poste manquant ci-dessous.
    //
    // F3-02 : la part de la course offerte par le vendeur est retenue sur son
    // reversement — Lilia l'encaisse au même titre que la part du client. La
    // course est donc payée `deliveryFee + vendorDeliverySubsidy`, soit le
    // prix de base, et c'est lui qu'il faut compter.
    const vendorDeliverySubsidy = breakdown.deliverySubsidyAmount ?? 0;
    const revenue =
      order.serviceFee +
      breakdown.commissionAmount +
      order.deliveryFee +
      vendorDeliverySubsidy;

    // ── Coûts variables connus ────────────────────────────────────────────
    // ⚠️ `discountAmount` est la remise TOTALE : promo + fidélité.
    // `loyaltyDiscount` en est une sous-partie (cf. `schema.prisma`). Les
    // additionner compterait la fidélité deux fois. On expose les deux pour la
    // lecture, on n'en déduit qu'un.
    const discount = order.discountAmount;

    // Un remboursement n'est un coût que lorsqu'il a réellement été versé.
    // `PENDING` ou `PROCESSING` = une dette, pas encore une sortie d'argent :
    // la déduire annoncerait une perte qui pourrait ne jamais survenir (un
    // remboursement peut être `REJECTED`).
    //
    // F3-06 — la part retenue sur le reversement du vendeur n'est pas une
    // perte de Lilia : elle ressort de l'argent qu'elle aurait versé.
    const refundPaid =
      order.refunds
        .filter((r) => r.status === RefundStatus.COMPLETED)
        .reduce((sum, r) => sum + r.amount, 0) -
      (breakdown.refundDeductionAmount ?? 0);

    // ── Coût du livreur — LU, jamais recalculé ────────────────────────────
    //
    // La valeur est figée sur la course à l'acceptation du livreur. La
    // recalculer ici ferait varier une commande passée au rythme des
    // changements de taux : c'est précisément ce que la commission vendeur a
    // coûté pendant des mois.
    //
    // `driverEconomicsFrozenAt` est le discriminant, pas `driverPayXaf` : un
    // montant à 0 est légitime (livreur au salaire, ou tarif de livraison nul)
    // et doit se distinguer d'un montant absent.
    const frozen = order.delivery?.driverEconomicsFrozenAt != null;
    const driverCost = frozen ? (order.delivery?.driverPayXaf ?? 0) : null;
    const liliaDeliveryShare =
      frozen && order.delivery?.driverBaseXaf != null
        ? order.delivery.driverBaseXaf - (order.delivery.driverPayXaf ?? 0)
        : null;

    const missingInputs: string[] = [];
    if (collectionFee === null) missingInputs.push('collectionFee');
    if (payoutFee === null) missingInputs.push('payoutFee');
    // Une livraison dont l'économie n'est pas gelée : soit aucun livreur ne
    // s'est encore engagé, soit la course a été faite hors système. Dans les
    // deux cas le coût est UNKNOWN — jamais 0, qui en ferait « gratuit ».
    if (order.isDelivery && driverCost === null)
      missingInputs.push('driverCost');

    const variableCosts =
      discount +
      (driverCost ?? 0) +
      (collectionFee ?? 0) +
      (payoutFee ?? 0) +
      refundPaid;

    const contributionMargin =
      missingInputs.length === 0 ? revenue - variableCosts : null;

    /**
     * Contribution **hors frais prestataire**.
     *
     * `Payment.collectionFeeXaf` et `RestaurantPayout.payoutFeeXaf` ne sont
     * jamais écrits : nos types pawaPay ne modélisent aucun frais, et la
     * production n'a jamais reçu un seul webhook. Attendre ces deux valeurs
     * pour afficher une marge revient à ne jamais l'afficher.
     *
     * On rend donc un second nombre, exact dès que le coût livreur est connu,
     * et nommé pour ce qu'il est. ⚠️ Il ne remplace pas `contributionMargin` :
     * les deux coexistent, et l'interface doit dire lequel elle montre. Le
     * confondre avec la marge réelle surestimerait le résultat du montant des
     * frais du prestataire.
     *
     * Reste `null` si le coût livreur manque : retirer les frais PSP ne
     * comble pas ce trou-là.
     */
    const blockingBeyondProviderFees = missingInputs.filter(
      (input) => input !== 'collectionFee' && input !== 'payoutFee',
    );
    const contributionMarginBeforeProviderFees =
      blockingBeyondProviderFees.length === 0
        ? revenue - (discount + (driverCost ?? 0) + refundPaid)
        : null;

    return {
      serviceFee: order.serviceFee,
      restaurantCommission: breakdown.commissionAmount,
      // Encaissés auprès du client, jamais reversés au vendeur.
      deliveryFeeCollected: order.deliveryFee,
      /** Part de la course offerte par le vendeur, retenue sur son reversement (F3-02). */
      vendorDeliverySubsidy,
      collectionFee,
      payoutFee,
      // Remises offertes par Lilia. `discountAmount` inclut `loyaltyDiscount` :
      // ne jamais les additionner.
      discountGranted: discount,
      loyaltyDiscount: order.loyaltyDiscount,
      refundPaid,

      /**
       * Rémunération due au livreur pour cette course, figée à l'acceptation.
       * `null` = **inconnue**. Ne jamais l'afficher comme 0.
       */
      driverCost,
      /** Part de Lilia sur la course : `driverBaseXaf − driverPayXaf`. */
      liliaDeliveryShare,
      /**
       * Rend un `driverCost` de 0 lisible : au salaire, zéro est la bonne
       * réponse. Sans ce champ, il serait indistinguable d'une anomalie.
       */
      driverCompensationModel: order.delivery?.driverCompensationModel ?? null,
      driverEmploymentType: order.delivery?.driverEmploymentType ?? null,
      driverSharePercent: order.delivery?.driverSharePercent ?? null,

      revenue,
      variableCosts,
      contributionMarginBeforeProviderFees,
      /**
       * Contribution réelle, ou `null` si un poste obligatoire est inconnu.
       * `missingInputs` nomme lesquels — un nombre absent qui dit pourquoi vaut
       * mieux qu'un nombre présent qui ment.
       */
      contributionMargin,
      missingInputs,
      /**
       * @deprecated Conservé pour les deux back-offices déjà déployés, qui
       * l'affichent sous le libellé « Marge nette ». Il vaut désormais
       * exactement `contributionMargin` — donc `null` sur toute commande
       * livrée, tant que le coût du livreur n'est pas capturé. Les deux fronts
       * gardent déjà ce cas (`if (netMargin != null)`) et masquent la ligne.
       * À retirer quand ils auront adopté `contributionMargin`.
       */
      netMargin: contributionMargin,
      currency: 'XAF',
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
    requestedBy: string | null;
    requestedAt: Date;
    completedAt: Date | null;
    debtDeductionAmount?: number;
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
      debtDeductionAmount: payout.debtDeductionAmount ?? 0,
    };
  }

  private orderRef(orderId: string): string {
    return orderId.slice(-6).toUpperCase();
  }
}

/**
 * Délai de carence après modification du compte de reversement (F-08), en
 * heures. `PAYOUT_ACCOUNT_COOLDOWN_HOURS=0` le désactive. Lu à chaque appel :
 * pas de valeur figée au chargement du module.
 */
export function payoutAccountCooldownHours(): number {
  const raw = Number(process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS ?? 24);
  return Number.isFinite(raw) && raw >= 0 ? raw : 24;
}

/**
 * Fin du délai de carence, ou `null` si le compte peut recevoir un virement.
 * Un compte jamais horodaté (antérieur au dispositif) n'est pas bloqué.
 */
export function payoutAccountCoolingUntil(
  changedAt: Date | null | undefined,
  now: Date,
): Date | null {
  const hours = payoutAccountCooldownHours();
  if (!changedAt || hours === 0) return null;
  const until = new Date(changedAt.getTime() + hours * 3_600_000);
  return until > now ? until : null;
}

function payoutCoolingMessage(until: Date): string {
  return (
    'Le compte de reversement de ce vendeur vient d’être modifié. Par sécurité, ' +
    `aucun virement n’y part avant le ${until.toLocaleString('fr-FR', { timeZone: 'Africa/Brazzaville' })}. ` +
    'Le vendeur a été prévenu du changement.'
  );
}
