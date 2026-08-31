import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  OrderStatus,
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  Prisma,
} from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../../prisma/prisma.service';
import { OrderPaymentConfirmedEvent } from '../../events/order-events';
import { OutboxService } from '../../outbox/outbox.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { PaymentProviderRegistry } from '../payment-provider.registry';
import {
  ManualPaymentInstructions,
  ProviderTransactionStatus,
  ProviderUnavailableError,
} from '../providers/payment-provider.interface';
import { PaymentEventService } from './payment-event.service';

/** Masque un numéro de téléphone pour les logs : garde les 2 derniers chiffres. */
export function maskPhone(phone?: string): string {
  if (!phone) return 'n/a';
  const trimmed = phone.trim();
  if (trimmed.length <= 2) return '***';
  return `***${trimmed.slice(-2)}`;
}

/** Masque une référence de transaction : garde les 4 derniers caractères. */
export function maskRef(ref?: string | null): string {
  if (!ref) return 'n/a';
  return ref.length <= 4 ? '****' : `****${ref.slice(-4)}`;
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * ⚠️ Ne PAS retyper la route sur une interface (fix H1) : une interface n'existe
 * pas au runtime, donc le ValidationPipe global ne valide rien. Le contrat HTTP
 * est porté par `dto/create-payment.dto.ts` ; ce type-ci n'est qu'un alias
 * interne pour les appels programmatiques.
 */
export type CreatePaymentRequest = CreatePaymentDto;

/** Issue d'un signal prestataire appliqué à un encaissement. */
export type ApplyOutcome = 'APPLIED' | 'DUPLICATE' | 'IGNORED' | 'MISMATCH';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  /**
   * Plafond de tentatives d'encaissement par commande.
   *
   * Sans plafond, chaque `POST /payments` déclenche une demande facturée chez le
   * prestataire, et surtout un push USSD sur le téléphone saisi : un attaquant
   * pourrait harceler un tiers en boucle. Le throttle (1/s, 10/min) ralentit,
   * il ne borne pas.
   */
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
    private readonly registry: PaymentProviderRegistry,
    private readonly events: PaymentEventService,
    private readonly outbox: OutboxService,
  ) {
    this.maxAttempts = Number(
      this.config.get<number>('PAYMENT_MAX_ATTEMPTS', 3),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Initiation
  // ══════════════════════════════════════════════════════════════════════════

  async createPayment(request: CreatePaymentRequest, firebaseUid: string) {
    const order = await this.getPayableOrder(request.orderId, firebaseUid);

    // Fix M3 : une commande intégralement réglée en points de fidélité a un
    // total de 0. Aucun opérateur mobile money n'accepte un transfert nul :
    // on affichait « Envoyez 0 FCFA au … », rien n'était payable, et le cron
    // annulait la commande. Il n'y a rien à encaisser — on la marque payée.
    if (order.total <= 0) {
      return this.settleZeroAmountOrder(order);
    }

    await this.assertAttemptsRemaining(order.id);

    const provider = this.registry.forNewTransaction();
    // ⚠️ Le montant vient de `order.total`, JAMAIS du corps de la requête —
    // `amount` a d'ailleurs été retiré du DTO pour que le contrat ne suggère
    // même pas le contraire.
    const amountXaf = Math.round(order.total);
    const method = request.method ?? order.paymentMethod;

    // L'identifiant prestataire est généré et PERSISTÉ AVANT l'appel : c'est ce
    // qui rend un rejeu sûr. Le regénérer à chaque tentative vaudrait un second
    // débit sur un simple timeout réseau.
    const payment = await this.acquireOrReusePendingPayment({
      orderId: order.id,
      amountXaf,
      phoneNumber: request.phoneNumber,
      method,
      providerName: provider.name,
    });

    // Une ligne réutilisée dont la demande a déjà été acceptée par le
    // prestataire ne doit pas en déclencher une seconde : le client attend
    // toujours devant son téléphone, et pawaPay répondrait DUPLICATE_IGNORED.
    if (payment.reused && payment.alreadySubmitted) {
      this.logger.log(
        `💰 Demande déjà en cours pour la commande ${order.id} — pas de nouvel envoi`,
      );
      return this.buildCreateResponse(payment.row, order, null);
    }

    let result: Awaited<ReturnType<typeof provider.createCollection>>;
    try {
      result = await provider.createCollection({
        paymentId: payment.row.id,
        providerTransactionId: payment.row.providerTransactionId!,
        amountXaf,
        currency: payment.row.currency,
        phoneNumber: request.phoneNumber,
        method,
        orderRef: this.orderRef(order.id),
        vendorName: order.restaurant.nom,
      });
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        // La ligne reste PENDING avec son identifiant : le retry rejouera la
        // MÊME demande. On ne la marque surtout pas en échec — on ne sait pas
        // si le prestataire l'a reçue.
        this.logger.error(
          `💰 Prestataire injoignable — commande ${order.id}, paiement ${payment.row.id}`,
        );
        throw new HttpException(
          {
            message: error.message,
            code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }
      throw error;
    }

    await this.events.record({
      kind: PaymentEventKind.COLLECTION,
      provider: provider.name,
      externalId: payment.row.providerTransactionId!,
      source: PaymentEventSource.INITIATION,
      rawStatus: result.accepted
        ? result.duplicate
          ? 'DUPLICATE_IGNORED'
          : 'ACCEPTED'
        : 'REJECTED',
      payload: result.raw,
      paymentId: payment.row.id,
      outcome: result.accepted
        ? PaymentEventOutcome.APPLIED
        : PaymentEventOutcome.IGNORED,
    });

    if (!result.accepted) {
      // Refus définitif du prestataire : la ligne passe FAILED pour libérer
      // l'index partiel et permettre une nouvelle tentative. La commande, elle,
      // reste EN_ATTENTE — un échec de paiement n'annule jamais une commande.
      await this.markPaymentFailed(
        payment.row.id,
        result.failureCode,
        result.failureMessage,
      );
      throw new BadRequestException(
        result.failureMessage ??
          "Le paiement n'a pas pu être initié auprès de l'opérateur.",
      );
    }

    this.logger.log(
      `💰 Encaissement initié — commande ${order.id}, ${amountXaf} XAF, ` +
        `ref ${maskRef(payment.row.providerTransactionId)}, tel ${maskPhone(request.phoneNumber)}`,
    );

    return this.buildCreateResponse(
      payment.row,
      order,
      result.instructions ?? null,
    );
  }

  /**
   * Crée la tentative de paiement, ou réutilise celle en cours.
   *
   * ⚠️ **C'est ici que se joue l'absence de double débit.** La version
   * précédente faisait un `findFirst` puis un `create` : deux requêtes
   * concurrentes lisaient toutes deux « aucun paiement en attente » et créaient
   * chacune leur ligne — donc deux demandes au prestataire, donc deux débits.
   *
   * On tente désormais l'insertion **d'abord** et on rattrape le `P2002` levé
   * par l'index unique partiel `payments_order_pending_uq`. La base arbitre, et
   * elle ne peut pas se tromper : une seule des deux transactions gagne.
   */
  private async acquireOrReusePendingPayment(input: {
    orderId: string;
    amountXaf: number;
    phoneNumber: string;
    method: Prisma.PaymentCreateInput['method'];
    providerName: string;
  }) {
    const providerTransactionId = randomUUID();

    try {
      const row = await this.prisma.payment.create({
        data: {
          orderId: input.orderId,
          amount: input.amountXaf,
          currency: 'XAF',
          phoneNumber: input.phoneNumber,
          method: input.method,
          status: PaymentStatus.PENDING,
          provider: input.providerName,
          providerTransactionId,
          metadata: {},
        },
      });
      return { row, reused: false, alreadySubmitted: false };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }

      const existing = await this.prisma.payment.findFirst({
        where: { orderId: input.orderId, status: PaymentStatus.PENDING },
      });
      if (!existing) {
        // La ligne concurrente a été résolue entre le conflit et la relecture.
        // Un 409 laisse le client réessayer proprement plutôt que de boucler.
        throw new ConflictException(
          'Un paiement vient d’être traité pour cette commande. Rechargez-la.',
        );
      }

      // Une tentative précédente a-t-elle déjà été soumise au prestataire ?
      const alreadySubmitted = await this.prisma.paymentEvent
        .findFirst({
          where: {
            paymentId: existing.id,
            source: PaymentEventSource.INITIATION,
            outcome: PaymentEventOutcome.APPLIED,
          },
          select: { id: true },
        })
        .then((event) => event !== null)
        .catch(() => false);

      this.logger.log(
        `💰 Paiement PENDING réutilisé pour la commande ${input.orderId} ` +
          `(soumis au prestataire : ${alreadySubmitted})`,
      );
      return { row: existing, reused: true, alreadySubmitted };
    }
  }

  private buildCreateResponse(
    payment: {
      id: string;
      amount: number;
      currency: string;
      method: string | null;
      provider: string;
    },
    order: { id: string },
    instructions: ManualPaymentInstructions | null,
  ) {
    return {
      paymentId: payment.id,
      orderId: order.id,
      status: PaymentStatus.PENDING,
      provider: payment.provider,
      method: payment.method,
      amount: payment.amount,
      currency: payment.currency,
      /**
       * Délai avant la première interrogation de statut. Le client attend
       * devant son téléphone : interroger trop tôt ne renvoie que du PENDING et
       * consomme sa data.
       */
      pollAfterMs: 3000,
      // Présentes uniquement en mode MANUAL.
      instructions: instructions ?? undefined,
      mode: this.registry.currentMode,
    };
  }

  /**
   * Commande à total nul (100 % points de fidélité) — fix M3.
   * Idempotent : rejouer l'appel renvoie le paiement existant.
   */
  private async settleZeroAmountOrder(order: {
    id: string;
    userId: string;
    restaurantId: string;
  }) {
    const existing = await this.prisma.payment.findFirst({
      where: { orderId: order.id, status: PaymentStatus.SUCCESS },
    });

    if (existing) {
      return {
        paymentId: existing.id,
        orderId: order.id,
        status: PaymentStatus.SUCCESS,
        provider: existing.provider,
        amount: 0,
        currency: 'XAF',
        mode: 'ZERO_AMOUNT',
        instructions: {
          message:
            'Commande intégralement réglée avec vos points de fidélité — rien à payer.',
          reference: existing.id.slice(-8).toUpperCase(),
          amount: 0,
          currency: 'XAF',
        },
      };
    }

    const { payment, outboxId } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          orderId: order.id,
          amount: 0,
          currency: 'XAF',
          phoneNumber: '',
          status: PaymentStatus.SUCCESS,
          provider: 'MANUAL',
          completedAt: new Date(),
          metadata: { mode: 'zero_amount', reason: 'loyalty_points_only' },
        },
      });

      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.EN_ATTENTE },
        data: { status: OrderStatus.PAYER, paidAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'Le statut de la commande a changé. Rechargez la commande.',
        );
      }

      const enqueued = await this.enqueueOrderPaid(tx, order, created.id, 0);
      return { payment: created, outboxId: enqueued };
    });

    this.emitPaymentConfirmed(order, payment.id, 0, outboxId);

    return {
      paymentId: payment.id,
      orderId: order.id,
      status: PaymentStatus.SUCCESS,
      provider: 'MANUAL',
      amount: 0,
      currency: 'XAF',
      mode: 'ZERO_AMOUNT',
      instructions: {
        message:
          'Commande intégralement réglée avec vos points de fidélité — rien à payer.',
        reference: payment.id.slice(-8).toUpperCase(),
        amount: 0,
        currency: 'XAF',
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Transition — LE point de passage unique
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Applique un statut annoncé par le prestataire.
   *
   * **Appelé par les trois sources** : le webhook, l'interrogation du client
   * (`GET /payments/:id/status`) et le cron de réconciliation. Un seul chemin,
   * donc un seul comportement — trois implémentations produiraient tôt ou tard
   * trois résultats différents sur la même transaction.
   *
   * Garanties :
   *  · le journal est écrit AVANT toute décision, y compris quand on refuse ;
   *  · le montant est contrôlé — un écart n'applique RIEN et ouvre un incident ;
   *  · la transition est conditionnée sur `status = PENDING` : le premier signal
   *    terminal gagne, les suivants sont des doublons sans effet, et un `FAILED`
   *    arrivé après un `COMPLETED` ne peut pas défaire un encaissement ;
   *  · l'obligation de notifier le vendeur est écrite DANS la transaction.
   */
  async applyCollectionProviderStatus(input: {
    paymentId: string;
    status: ProviderTransactionStatus;
    source: PaymentEventSource;
  }): Promise<ApplyOutcome> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: input.paymentId },
      include: {
        order: {
          select: { id: true, userId: true, restaurantId: true, status: true },
        },
      },
    });

    if (!payment) return 'IGNORED';

    const eventId = await this.events.record({
      kind: PaymentEventKind.COLLECTION,
      provider: payment.provider,
      externalId: payment.providerTransactionId ?? payment.id,
      source: input.source,
      rawStatus: input.status.rawStatus,
      payload: input.status.raw,
      paymentId: payment.id,
    });

    // ── Statut non terminal : rien à décider ──────────────────────────────────
    if (input.status.state === 'PENDING') {
      await this.events.setOutcome(eventId, PaymentEventOutcome.IGNORED);
      return 'IGNORED';
    }

    // ── Contrôle du montant et de la devise ───────────────────────────────────
    const mismatch = this.detectMismatch(payment, input.status);
    if (mismatch) {
      await this.events.setOutcome(eventId, PaymentEventOutcome.MISMATCH);
      this.logger.error(
        `🚨 [PAIEMENT] Incohérence de montant — paiement ${payment.id}, ${mismatch}`,
      );
      Sentry.captureMessage(
        `payment.mismatch — paiement ${payment.id} : ${mismatch}`,
        'error',
      );
      await this.openMismatchIncident(payment.id, payment.orderId, mismatch);
      return 'MISMATCH';
    }

    if (input.status.state === 'FAILED') {
      const applied = await this.markPaymentFailed(
        payment.id,
        input.status.failureCode,
        input.status.failureMessage,
      );
      await this.events.setOutcome(
        eventId,
        applied ? PaymentEventOutcome.APPLIED : PaymentEventOutcome.DUPLICATE,
      );
      if (applied) {
        this.eventEmitter.emit('order.payment.failed', {
          orderId: payment.orderId,
          userId: payment.order.userId,
          paymentId: payment.id,
          reason:
            input.status.failureMessage ??
            input.status.failureCode ??
            'Paiement refusé par l’opérateur',
        });
      }
      return applied ? 'APPLIED' : 'DUPLICATE';
    }

    // ── Succès ────────────────────────────────────────────────────────────────
    return this.confirmCollection(payment, input.status, eventId);
  }

  private async confirmCollection(
    payment: {
      id: string;
      orderId: string;
      amount: number;
      providerTransactionId: string | null;
      order: { id: string; userId: string; restaurantId: string };
    },
    status: ProviderTransactionStatus,
    eventId: string | null,
  ): Promise<ApplyOutcome> {
    let outboxId: string | null = null;
    let orderMoved = false;

    const claimed = await this.prisma.$transaction(async (tx) => {
      // Seul le premier signal terminal transite. `count === 0` ⇒ rejeu.
      const payClaim = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.SUCCESS,
          completedAt: new Date(),
          failureCode: null,
          failureMessage: null,
          providerTransactionId: payment.providerTransactionId,
          metadata: {
            providerTransactionId: status.providerTransactionId ?? null,
            confirmedFrom: status.rawStatus,
          },
        },
      });
      if (payClaim.count === 0) return false;

      const orderClaim = await tx.order.updateMany({
        where: { id: payment.orderId, status: OrderStatus.EN_ATTENTE },
        data: { status: OrderStatus.PAYER, paidAt: new Date() },
      });
      orderMoved = orderClaim.count > 0;

      if (orderMoved) {
        // L'obligation de prévenir le vendeur est écrite DANS la transaction :
        // si la commande est payée, la notification est due. C'est aussi le
        // moment — et non `order.created` — parce qu'une commande non payée
        // n'a pas à déranger un vendeur.
        outboxId = await this.enqueueOrderPaid(
          tx,
          payment.order,
          payment.id,
          payment.amount,
        );
      }
      return true;
    });

    if (!claimed) {
      await this.events.setOutcome(eventId, PaymentEventOutcome.DUPLICATE);
      return 'DUPLICATE';
    }

    await this.events.setOutcome(eventId, PaymentEventOutcome.APPLIED);

    if (!orderMoved) {
      // Le paiement a abouti mais la commande n'était plus en attente : expirée
      // par le cron, ou annulée. On ne force AUCUNE transition — l'argent
      // existe, la commande non : c'est un litige, pas un cas nominal.
      this.logger.error(
        `🚨 [PAIEMENT] Encaissement sur commande non payable — paiement ${payment.id}, commande ${payment.orderId}`,
      );
      Sentry.captureMessage(
        `payment.orphan — encaissement ${payment.id} sur commande ${payment.orderId} hors EN_ATTENTE`,
        'error',
      );
      this.eventEmitter.emit('payment.orphaned', {
        orderId: payment.orderId,
        paymentId: payment.id,
        amount: payment.amount,
      });
      return 'APPLIED';
    }

    this.emitPaymentConfirmed(
      payment.order,
      payment.id,
      payment.amount,
      outboxId,
    );
    this.logger.log(
      `💰 [PAIEMENT] ✅ Confirmé — commande ${payment.orderId}, ${payment.amount} XAF`,
    );
    return 'APPLIED';
  }

  /**
   * Écart entre ce qu'on a demandé et ce que le prestataire annonce.
   *
   * On compare le montant **et** la devise. Un prestataire qui confirme un autre
   * montant que celui enregistré signale soit une erreur de son côté, soit une
   * requête forgée : dans les deux cas, on ne conclut rien.
   *
   * Une tolérance d'un franc absorbe les arrondis de représentation (les
   * montants voyagent en chaîne décimale), sans laisser passer d'écart réel.
   */
  private detectMismatch(
    payment: { amount: number; currency: string },
    status: ProviderTransactionStatus,
  ): string | null {
    if (status.currency && status.currency !== payment.currency) {
      return `devise attendue ${payment.currency}, reçue ${status.currency}`;
    }
    if (status.amountXaf === undefined) {
      // Le prestataire n'annonce pas de montant : on ne peut pas contrôler, mais
      // on ne bloque pas — le contrôle est une défense supplémentaire, pas la
      // seule (l'identifiant de transaction est déjà unique et généré par nous).
      return null;
    }
    const expected = Math.round(payment.amount);
    if (Math.abs(status.amountXaf - expected) > 1) {
      return `montant attendu ${expected}, reçu ${status.amountXaf}`;
    }
    return null;
  }

  private async openMismatchIncident(
    paymentId: string,
    orderId: string,
    detail: string,
  ) {
    await this.prisma.incident
      .create({
        data: {
          type: 'PAYMENT_FAILED',
          severity: 'CRITICAL',
          title: 'Incohérence de montant sur un encaissement',
          description:
            `Le prestataire a annoncé un statut terminal avec un montant ou une devise ` +
            `différents de ceux enregistrés (${detail}). Aucune transition n'a été appliquée. ` +
            `Vérifier auprès du prestataire avant toute action manuelle.`,
          orderId,
          metadata: { paymentId, detail },
        },
      })
      .catch((error) =>
        this.logger.error(
          `Incident d'incohérence non créé : ${(error as Error).message}`,
        ),
      );
  }

  /**
   * Passe un encaissement en échec. Conditionné sur `PENDING` : un paiement déjà
   * résolu n'est jamais réécrit.
   *
   * **La commande n'est pas touchée.** Elle reste `EN_ATTENTE`, donc payable —
   * c'est ce qui rend le retry possible.
   */
  private async markPaymentFailed(
    paymentId: string,
    failureCode?: string,
    failureMessage?: string,
  ): Promise<boolean> {
    const claimed = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.FAILED,
        completedAt: new Date(),
        failureCode: failureCode ?? null,
        failureMessage: failureMessage ?? null,
      },
    });
    return claimed.count > 0;
  }

  private async enqueueOrderPaid(
    tx: Prisma.TransactionClient,
    order: { id: string; userId: string; restaurantId: string },
    paymentId: string,
    amount: number,
  ): Promise<string> {
    return this.outbox.enqueueInTransaction(tx, {
      type: 'order.paid',
      aggregateId: order.id,
      payload: {
        orderId: order.id,
        userId: order.userId,
        restaurantId: order.restaurantId,
        paymentId,
        amount,
      },
    });
  }

  private emitPaymentConfirmed(
    order: { id: string; userId: string; restaurantId: string },
    paymentId: string,
    amount: number,
    outboxId: string | null,
  ) {
    this.eventEmitter.emit(
      'order.payment.confirmed',
      new OrderPaymentConfirmedEvent(
        order.id,
        order.userId,
        order.restaurantId,
        paymentId,
        amount,
      ),
    );
    if (outboxId) {
      this.eventEmitter.emit('order.paid', {
        orderId: order.id,
        userId: order.userId,
        restaurantId: order.restaurantId,
        paymentId,
        amount,
        outboxId,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Consultation
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Statut d'un encaissement.
   *
   * Un statut **terminal est lu en base**, sans appeler le prestataire : la
   * vérité est déjà connue, et l'application interroge cette route toutes les
   * trois secondes pendant que le client attend.
   */
  async checkPaymentStatus(paymentId: string, firebaseUid?: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: { select: { userId: true, status: true } } },
    });
    if (!payment) throw new NotFoundException('Paiement introuvable.');

    if (firebaseUid) {
      await this.assertPaymentAccess(payment.order.userId, firebaseUid);
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return this.toStatusResponse(payment);
    }

    const provider = this.registry.forStoredProvider(payment.provider);
    if (!payment.providerTransactionId || !provider.supportsCollection) {
      // Mode manuel : la vérité est la ligne en base, que seul un administrateur
      // fait avancer. Interroger un prestataire n'aurait aucun sens (l'ancienne
      // implémentation appelait MTN avec une référence nulle et avalait l'erreur).
      return this.toStatusResponse(payment);
    }

    try {
      const status = await provider.getCollectionStatus(
        payment.providerTransactionId,
      );
      if (status) {
        await this.applyCollectionProviderStatus({
          paymentId: payment.id,
          status,
          source: PaymentEventSource.CLIENT_POLL,
        });
      }
    } catch (error) {
      // Une interrogation qui échoue ne doit pas casser l'écran d'attente du
      // client : on rend le dernier état connu.
      this.logger.warn(
        `Interrogation du prestataire échouée pour ${paymentId} : ${(error as Error).message}`,
      );
    }

    const refreshed = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    return this.toStatusResponse(refreshed);
  }

  private toStatusResponse(payment: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    failureCode: string | null;
    failureMessage: string | null;
    completedAt: Date | null;
    orderId: string;
  }) {
    return {
      paymentId: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      failureCode: payment.failureCode ?? undefined,
      failureMessage: payment.failureMessage ?? undefined,
      completedAt: payment.completedAt ?? undefined,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Chemins d'administration — mode MANUAL
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Confirmation manuelle par un administrateur (mode MANUAL).
   *
   * Conservée telle quelle : c'est le chemin de production actuel et le filet en
   * cas de panne du prestataire. Elle passe désormais par
   * `applyCollectionProviderStatus`, donc par les mêmes garanties que le webhook.
   */
  async confirmManualPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true },
    });

    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException('Paiement déjà traité');
    }

    // Fix H2 : refuser de confirmer un virement sur une commande qui n'attend
    // plus de paiement. Sans cette garde, l'administrateur ressuscitait une
    // commande annulée dont le stock avait été rendu et les points recrédités.
    if (payment.order.status !== OrderStatus.EN_ATTENTE) {
      throw new ConflictException(
        `Cette commande n'attend plus de paiement (statut : ${payment.order.status}). ` +
          `Si le client a réellement payé, traitez-le par la procédure de remboursement.`,
      );
    }

    const outcome = await this.applyCollectionProviderStatus({
      paymentId,
      status: {
        state: 'SUCCESS',
        rawStatus: 'MANUAL_CONFIRMED',
        amountXaf: Math.round(payment.amount),
        currency: payment.currency,
        raw: { confirmedBy: 'admin' },
      },
      source: PaymentEventSource.WEBHOOK,
    });

    if (outcome === 'DUPLICATE') {
      throw new ConflictException('Paiement déjà traité');
    }

    return { message: 'Paiement confirmé manuellement' };
  }

  /**
   * Rejet manuel (mode MANUAL) — l'administrateur n'a pas retrouvé le virement.
   * La commande reste `EN_ATTENTE` : le client peut réessayer.
   */
  async rejectManualPayment(paymentId: string, reason?: string) {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true },
    });

    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException('Paiement déjà traité');
    }

    const rejectionReason = reason?.trim() || 'Virement non retrouvé';

    const claimed = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.CANCELLED,
        completedAt: new Date(),
        failureCode: 'ADMIN_REJECTED',
        failureMessage: rejectionReason,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException('Paiement déjà traité');
    }

    this.eventEmitter.emit('order.payment.failed', {
      orderId: payment.orderId,
      userId: payment.order.userId,
      paymentId: payment.id,
      reason: rejectionReason,
    });

    return { message: 'Paiement rejeté' };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Garde-fous
  // ══════════════════════════════════════════════════════════════════════════

  private async getPayableOrder(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: { select: { nom: true } } },
    });
    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.userId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à payer cette commande",
      );
    }
    if (order.status !== OrderStatus.EN_ATTENTE) {
      throw new BadRequestException(
        `Commande non payable dans le statut actuel : ${order.status}`,
      );
    }
    return order;
  }

  /** Plafond de tentatives — voir `maxAttempts`. */
  private async assertAttemptsRemaining(orderId: string) {
    if (this.maxAttempts <= 0) return;
    const failed = await this.prisma.payment.count({
      where: {
        orderId,
        status: { in: [PaymentStatus.FAILED, PaymentStatus.CANCELLED] },
      },
    });
    if (failed >= this.maxAttempts) {
      throw new BadRequestException(
        `Trop de tentatives de paiement sur cette commande (${failed}). ` +
          'Elle sera annulée automatiquement ; vous pourrez la repasser.',
      );
    }
  }

  private async assertPaymentAccess(orderUserId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    if (user.role !== 'ADMIN' && user.id !== orderUserId) {
      throw new ForbiddenException('Accès au paiement refusé');
    }
  }

  /** Référence courte affichée au client et transmise au prestataire. */
  private orderRef(orderId: string): string {
    return orderId.slice(-6).toUpperCase();
  }

  /**
   * Retrouve un encaissement par sa référence prestataire — utilisé par le
   * webhook. L'index unique `(provider, providerTransactionId)` garantit qu'au
   * plus une ligne correspond.
   */
  async findByProviderTransactionId(provider: string, externalId: string) {
    return this.prisma.payment.findFirst({
      where: { provider, providerTransactionId: externalId },
    });
  }
}
