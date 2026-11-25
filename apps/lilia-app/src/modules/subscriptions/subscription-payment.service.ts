import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  PaymentMethod,
  Prisma,
  SubscriptionPayment,
} from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
import { randomBytes, randomUUID } from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { SUBSCRIPTION_ACTIVATED_EVENT } from '../outbox/outbox-events';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';
import {
  ProviderTransactionStatus,
  ProviderUnavailableError,
} from '../payments/providers/payment-provider.interface';
import {
  guardSignalOutcome,
  PaymentEventService,
} from '../payments/services/payment-event.service';
import { maskPhone, maskRef } from '../payments/services/payment.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { subscriptionVerdict } from './entitlements';
import {
  IN_PLATFORM_PAYMENT_METHOD,
  SUBSCRIPTION_DURATIONS_MONTHS,
  SubscriptionDurationMonths,
  SubscriptionPaymentStatus,
} from './plans';
import { stackPeriods } from './subscription-stacking';

/** Issue d'un signal prestataire appliqué à un paiement d'abonnement. */
export type SubscriptionPaymentApplyOutcome =
  | 'APPLIED'
  | 'DUPLICATE'
  | 'IGNORED'
  | 'MISMATCH';

/** Auteur des mois ouverts par un paiement (pas de FK, comme `grantedById`). */
export const SYSTEM_GRANTOR = 'SYSTEM:pawapay';

/**
 * Délai avant qu'une lecture du vendeur n'interroge le prestataire : le
 * vendeur compose encore son code, une interrogation immédiate ne rendrait
 * que `PENDING` et coûterait un appel.
 */
const CLIENT_POLL_GRACE_MS = 15_000;

/** Ce que voit le vendeur (et l'administrateur) d'une tentative. */
export interface SubscriptionPaymentView {
  id: string;
  months: number;
  unitPriceXaf: number;
  amountXaf: number;
  currency: string;
  method: PaymentMethod;
  phoneNumber: string;
  reference: string;
  status: string;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
  grantedAt: Date | null;
}

/**
 * Premium S1 (25/11/2026) — le vendeur paie son abonnement **dans la
 * plateforme**, par un dépôt pawaPay.
 *
 * Mêmes garanties que l'encaissement d'une commande, sur une table à part
 * (`payments.orderId` est NOT NULL) :
 *  · `depositId` généré et persisté **avant** l'appel : un rejeu ne débite
 *    jamais deux fois ;
 *  · une seule tentative `PENDING` par vendeur (index unique partiel) ;
 *  · seul le prestataire décide du succès (webhook signé, réconciliation ou
 *    interrogation serveur — règle 3), par **un seul chemin**,
 *    `applyProviderStatus` ;
 *  · montant ET devise contrôlés à l'égalité stricte ;
 *  · `SUCCESS` ⇔ mois créés : la transition et l'empilement sont dans la même
 *    transaction, sous le verrou `Restaurant` que prend aussi l'attribution
 *    par un administrateur. Clé `pawapay:<paiement>:<i>` unique : un signal
 *    rejoué ne crée jamais un mois de plus.
 *
 * Décisions du 25/11 : un échec ne bloque rien, le vendeur réessaie ; un
 * `SUCCESS` arrivé après une clôture locale en échec (réconciliation) ouvre
 * quand même les mois — l'argent est reçu.
 */
@Injectable()
export class SubscriptionPaymentService {
  private readonly logger = new Logger(SubscriptionPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly registry: PaymentProviderRegistry,
    private readonly events: PaymentEventService,
    private readonly outbox: OutboxService,
  ) {}

  // ─── Vendeur ──────────────────────────────────────────────────────────────

  /**
   * Offre et état Premium du vendeur connecté : statut, prix, durées avec
   * leur montant, tentative en cours et dernières tentatives. Tout vient du
   * serveur : l'écran n'additionne rien (règle 2).
   */
  async offerForOwner(ownerId: string, now: Date = new Date()) {
    const vendor = await this.vendorOf(ownerId);
    const [periods, settings, payments] = await Promise.all([
      this.prisma.vendorSubscription.findMany({
        where: {
          restaurantId: vendor.id,
          status: 'ACTIVE',
          endsAt: { gt: now },
        },
        select: { plan: true, status: true, startsAt: true, endsAt: true },
      }),
      this.platformSettings.getSettings(),
      this.prisma.subscriptionPayment.findMany({
        where: { restaurantId: vendor.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    const unitPriceXaf = settings.premiumMonthlyPriceXaf;
    const provider = this.registry.forNewTransaction();
    const pending = payments.find((p) => p.status === 'PENDING');
    return {
      verdict: subscriptionVerdict(periods, now),
      unitPriceXaf,
      currency: 'XAF',
      durations: SUBSCRIPTION_DURATIONS_MONTHS.map((months) => ({
        months,
        amountXaf: months * unitPriceXaf,
      })),
      /** Le vendeur peut-il payer maintenant ? Sinon, `blockedReason` dit pourquoi. */
      canPay: vendor.adminApproved && provider.supportsCollection,
      blockedReason: !vendor.adminApproved
        ? 'VENDOR_NOT_APPROVED'
        : !provider.supportsCollection
          ? 'ONLINE_PAYMENT_UNAVAILABLE'
          : null,
      pendingPayment: pending ? this.toView(pending) : null,
      recentPayments: payments.map((p) => this.toView(p)),
    };
  }

  /**
   * Lance un dépôt pawaPay pour `months` mois. Le prix est lu ici et figé sur
   * la ligne ; le client n'envoie ni montant ni prix.
   */
  async startForOwner(
    ownerId: string,
    input: {
      months: SubscriptionDurationMonths;
      phoneNumber: string;
      method: PaymentMethod;
    },
  ): Promise<SubscriptionPaymentView> {
    const vendor = await this.vendorOf(ownerId);
    if (!vendor.adminApproved) {
      throw new ForbiddenException({
        message:
          'Votre boutique doit être validée par Lilia avant de souscrire à Premium.',
        code: 'VENDOR_NOT_APPROVED',
      });
    }
    const provider = this.registry.forNewTransaction();
    if (!provider.supportsCollection) {
      throw new ServiceUnavailableException({
        message:
          'Le paiement en ligne est indisponible pour le moment. Réessayez plus tard.',
        code: 'ONLINE_PAYMENT_UNAVAILABLE',
      });
    }

    const { premiumMonthlyPriceXaf: unitPriceXaf } =
      await this.platformSettings.getSettings();
    const amountXaf = input.months * unitPriceXaf;

    let row: SubscriptionPayment;
    try {
      // `depositId` généré et persisté AVANT l'appel : c'est ce qui rend un
      // rejeu sûr (DUPLICATE_IGNORED chez pawaPay, jamais un second débit).
      row = await this.prisma.subscriptionPayment.create({
        data: {
          restaurantId: vendor.id,
          months: input.months,
          unitPriceXaf,
          amountXaf,
          phoneNumber: input.phoneNumber,
          method: input.method,
          provider: provider.name,
          providerTransactionId: randomUUID(),
          reference: newReference(),
          requestedById: ownerId,
        },
      });
    } catch (error) {
      // Index unique partiel : une tentative est déjà en cours. C'est la base
      // qui arbitre deux clics simultanés.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          message:
            'Un paiement est déjà en cours : validez-le sur votre téléphone ou attendez son résultat.',
          code: 'SUBSCRIPTION_PAYMENT_PENDING',
        });
      }
      throw error;
    }

    let result: Awaited<ReturnType<typeof provider.createCollection>>;
    try {
      result = await provider.createCollection({
        paymentId: row.id,
        providerTransactionId: row.providerTransactionId,
        amountXaf,
        currency: row.currency,
        phoneNumber: input.phoneNumber,
        method: input.method,
        orderRef: row.reference,
        vendorName: vendor.nom,
      });
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        // On ne sait pas si le prestataire a reçu la demande : la ligne reste
        // PENDING avec son identifiant, la réconciliation tranchera (ou la
        // clôturera faute de trace). Surtout pas FAILED. L'écran la retrouve
        // par `pendingPayment` de l'offre.
        this.logger.error(
          `👑 Prestataire injoignable — paiement d'abonnement ${row.id} (vendeur ${vendor.id})`,
        );
        await this.events.record({
          kind: PaymentEventKind.COLLECTION,
          provider: provider.name,
          externalId: row.providerTransactionId,
          source: PaymentEventSource.INITIATION,
          rawStatus: 'PROVIDER_UNAVAILABLE',
          payload: { message: error.message },
          outcome: PaymentEventOutcome.IGNORED,
        });
        Sentry.captureMessage(
          `subscription_payment.provider_unavailable — paiement ${row.id}`,
          'warning',
        );
        throw new HttpException(
          {
            message:
              "L'opérateur ne répond pas. Si vous recevez une demande de paiement, validez-la ; sinon réessayez dans quelques minutes.",
            code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }
      // Erreur inattendue : on ne sait pas davantage si la demande est partie.
      // La ligne reste PENDING (jamais FAILED à l'aveugle : un SUCCESS
      // ultérieur serait alors accordé, mais le vendeur aurait pu repayer) ;
      // la réconciliation tranche en 15 min au plus. L'erreur doit se voir.
      Sentry.captureException(error);
      this.logger.error(
        `👑 Échec inattendu à l'initiation du paiement d'abonnement ${row.id} : ${(error as Error).message}`,
      );
      throw error;
    }

    await this.events.record({
      kind: PaymentEventKind.COLLECTION,
      provider: provider.name,
      externalId: row.providerTransactionId,
      source: PaymentEventSource.INITIATION,
      rawStatus: result.accepted
        ? result.duplicate
          ? 'DUPLICATE_IGNORED'
          : 'ACCEPTED'
        : 'REJECTED',
      payload: result.raw,
      outcome: result.accepted
        ? PaymentEventOutcome.APPLIED
        : PaymentEventOutcome.IGNORED,
    });

    if (!result.accepted) {
      // Refus définitif : la ligne passe FAILED, ce qui libère l'index partiel
      // — le vendeur peut réessayer tout de suite.
      await this.prisma.subscriptionPayment.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          failureCode: result.failureCode ?? 'REJECTED',
          failureMessage: result.failureMessage ?? null,
        },
      });
      throw new BadRequestException({
        message:
          result.failureMessage ??
          "Le paiement n'a pas pu être lancé auprès de l'opérateur.",
        code: 'SUBSCRIPTION_PAYMENT_REJECTED',
      });
    }

    this.logger.log(
      `👑 Paiement d'abonnement lancé — vendeur ${vendor.id}, ${input.months} mois, ` +
        `${amountXaf} XAF, ref ${maskRef(row.providerTransactionId)}, tel ${maskPhone(input.phoneNumber)}`,
    );
    return this.toView(row);
  }

  /**
   * Une tentative du vendeur connecté. Encore `PENDING` après le délai de
   * grâce : on interroge le prestataire, par le même chemin que le webhook.
   * Un échec de cette interrogation n'empêche jamais la lecture.
   */
  async findForOwner(
    ownerId: string,
    paymentId: string,
    now: Date = new Date(),
  ): Promise<SubscriptionPaymentView> {
    const vendor = await this.vendorOf(ownerId);
    // Ownership : la tentative doit appartenir à la boutique de l'appelant.
    let row = await this.prisma.subscriptionPayment.findFirst({
      where: { id: paymentId, restaurantId: vendor.id },
    });
    if (!row) throw new NotFoundException('Paiement introuvable.');

    if (
      row.status === 'PENDING' &&
      now.getTime() - row.createdAt.getTime() >= CLIENT_POLL_GRACE_MS
    ) {
      try {
        const provider = this.registry.forStoredProvider(row.provider);
        if (provider.supportsCollection) {
          const status = await provider.getCollectionStatus(
            row.providerTransactionId,
          );
          if (status) {
            await this.applyProviderStatus({
              paymentId: row.id,
              status,
              source: PaymentEventSource.CLIENT_POLL,
            });
            row = await this.prisma.subscriptionPayment.findUniqueOrThrow({
              where: { id: row.id },
            });
          }
        }
      } catch (error) {
        // La lecture reste servie. Un prestataire injoignable est banal (le
        // webhook et la réconciliation suivent) ; une erreur d'application
        // (base, transaction) ne l'est pas et doit remonter.
        if (error instanceof ProviderUnavailableError) {
          this.logger.warn(
            `Interrogation du paiement d'abonnement ${row.id} impossible : ${error.message}`,
          );
        } else {
          this.logger.error(
            `Application du statut du paiement d'abonnement ${row.id} en échec : ${(error as Error).message}`,
          );
          Sentry.captureException(error);
        }
      }
    }
    return this.toView(row);
  }

  // ─── Prestataire (webhook, réconciliation, interrogation) ──────────────────

  async findByProviderTransactionId(provider: string, externalId: string) {
    return this.prisma.subscriptionPayment.findFirst({
      where: { provider, providerTransactionId: externalId },
      select: { id: true },
    });
  }

  /** Seul point de transition d'un paiement d'abonnement. */
  async applyProviderStatus(input: {
    paymentId: string;
    status: ProviderTransactionStatus;
    source: PaymentEventSource;
  }): Promise<SubscriptionPaymentApplyOutcome> {
    const payment = await this.prisma.subscriptionPayment.findUnique({
      where: { id: input.paymentId },
    });
    if (!payment) return 'IGNORED';

    // Journal écrit avant toute décision.
    const eventId = await this.events.record({
      kind: PaymentEventKind.COLLECTION,
      provider: payment.provider,
      externalId: payment.providerTransactionId,
      source: input.source,
      rawStatus: input.status.rawStatus,
      payload: input.status.raw,
    });

    return guardSignalOutcome(this.events, eventId, () =>
      this.applyRecordedStatus(payment, input.status, eventId),
    );
  }

  /**
   * Réconciliation : le prestataire ne sait rien de la transaction après le
   * délai — elle n'est jamais partie. Clôture en échec (le vendeur peut
   * réessayer) ; un `SUCCESS` tardif ouvrirait quand même les mois.
   */
  async abandon(paymentId: string): Promise<boolean> {
    const claimed = await this.prisma.subscriptionPayment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        failureCode: 'RECONCILIATION_TIMEOUT',
        failureMessage:
          "Le prestataire n'a jamais confirmé cette transaction dans le délai imparti.",
      },
    });
    return claimed.count > 0;
  }

  /**
   * Tentatives closes faute de réponse du prestataire depuis `since` : elles
   * peuvent encore aboutir chez lui (réinterrogation bornée).
   */
  async recentlyAbandoned(since: Date, take: number) {
    return this.prisma.subscriptionPayment.findMany({
      where: {
        status: 'FAILED',
        failureCode: 'RECONCILIATION_TIMEOUT',
        completedAt: { gte: since },
      },
      select: { id: true, provider: true, providerTransactionId: true },
      orderBy: { completedAt: 'asc' },
      take,
    });
  }

  /** Tentatives `PENDING` plus anciennes que `cutoff` (réconciliation). */
  async stalePending(cutoff: Date, take: number) {
    return this.prisma.subscriptionPayment.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: {
        id: true,
        provider: true,
        providerTransactionId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  // ─── Administration ───────────────────────────────────────────────────────

  async listForAdmin(filter: {
    status?: SubscriptionPaymentStatus;
    restaurantId?: string;
    page: number;
    limit: number;
  }) {
    const where: Prisma.SubscriptionPaymentWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.restaurantId ? { restaurantId: filter.restaurantId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.subscriptionPayment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
        include: { restaurant: { select: { id: true, nom: true } } },
      }),
      this.prisma.subscriptionPayment.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        ...this.toView(r),
        // Numéro masqué en liste : le détail reste chez le prestataire.
        phoneNumber: maskPhone(r.phoneNumber),
        restaurant: r.restaurant,
        provider: r.provider,
        collectionFeeXaf: r.collectionFeeXaf,
      })),
      meta: {
        total,
        page: filter.page,
        limit: filter.limit,
        totalPages: Math.ceil(total / filter.limit),
      },
    };
  }

  // ─── Interne ──────────────────────────────────────────────────────────────

  private async applyRecordedStatus(
    payment: SubscriptionPayment,
    status: ProviderTransactionStatus,
    eventId: string | null,
  ): Promise<SubscriptionPaymentApplyOutcome> {
    if (status.state === 'PENDING') {
      await this.events.setOutcome(eventId, PaymentEventOutcome.IGNORED);
      return 'IGNORED';
    }

    const mismatch = this.mismatch(status, payment);
    if (mismatch) {
      await this.events.setOutcome(eventId, PaymentEventOutcome.MISMATCH);
      this.logger.error(
        `🚨 [PREMIUM] Incohérence — paiement d'abonnement ${payment.id} : ${mismatch}`,
      );
      // La ligne reste PENDING et la réconciliation la rejoue : Sentry n'est
      // alerté qu'à l'ouverture de l'incident, pas à chaque passage.
      if (await this.openIncident(payment, mismatch)) {
        Sentry.captureMessage(
          `subscription_payment.mismatch — paiement ${payment.id}`,
          'error',
        );
      }
      return 'MISMATCH';
    }

    const outcome =
      status.state === 'SUCCESS'
        ? await this.applySuccess(payment, status)
        : await this.applyFailure(payment, status);

    await this.events.setOutcome(
      eventId,
      outcome === 'APPLIED'
        ? PaymentEventOutcome.APPLIED
        : PaymentEventOutcome.DUPLICATE,
    );
    return outcome;
  }

  /**
   * `SUCCESS` : transition, mois et obligation de prévenir le vendeur, ou
   * rien. Accepté depuis `PENDING` **et** depuis `FAILED` (paiement confirmé
   * après une clôture locale — décision du 25/11) ; jamais deux fois.
   */
  private async applySuccess(
    payment: SubscriptionPayment,
    status: ProviderTransactionStatus,
  ): Promise<'APPLIED' | 'DUPLICATE'> {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // Ordre des verrous : le paiement, puis la boutique (`grant` ne prend
      // que la boutique) — aucun cycle possible. Boutique en `FOR NO KEY
      // UPDATE` : il sérialise toujours avec `grant`/`revoke` (FOR UPDATE),
      // sans bloquer les INSERT qui pointent vers elle (commandes, produits).
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "SubscriptionPayment" WHERE "id" = ${payment.id} FOR UPDATE
      `;
      if (!locked || locked.status === 'SUCCESS') return null;
      const previous = locked.status;

      const claimed = await tx.subscriptionPayment.updateMany({
        where: { id: payment.id, status: previous },
        data: {
          status: 'SUCCESS',
          completedAt: now,
          failureCode: null,
          failureMessage: null,
          grantedAt: now,
        },
      });
      if (claimed.count === 0) return null;

      await tx.$queryRaw`
        SELECT "id" FROM "Restaurant" WHERE "id" = ${payment.restaurantId} FOR NO KEY UPDATE
      `;
      const months = await stackPeriods(tx, {
        restaurantId: payment.restaurantId,
        months: payment.months,
        priceXaf: payment.unitPriceXaf,
        paymentMethod: IN_PLATFORM_PAYMENT_METHOD,
        paymentReference: payment.reference,
        requestKeyFor: (i) => `pawapay:${payment.id}:${i}`,
        grantedById: SYSTEM_GRANTOR,
        subscriptionPaymentId: payment.id,
        now,
      });

      // Règle 11 : l'avis au vendeur doit survivre à un crash — outbox, dans
      // la transaction qui crée les mois.
      await this.outbox.enqueueInTransaction(tx, {
        type: SUBSCRIPTION_ACTIVATED_EVENT,
        aggregateId: payment.restaurantId,
        payload: { subscriptionPaymentId: payment.id },
      });
      return { previous, paidUntil: months[months.length - 1].endsAt };
    });

    if (!result) return 'DUPLICATE';
    if (result.previous === 'FAILED') {
      // Paiement confirmé après une clôture locale : mois accordés quand même
      // (décision du 25/11), mais le cas doit rester visible.
      this.logger.warn(
        `👑 [PREMIUM] Paiement ${payment.id} confirmé APRÈS une clôture en échec — mois accordés.`,
      );
      Sentry.captureMessage(
        `subscription_payment.late_success — paiement ${payment.id}`,
        'warning',
      );
    }
    this.logger.log(
      `👑 [PREMIUM] ✅ ${payment.months} mois ouverts pour ${payment.restaurantId} ` +
        `(${payment.amountXaf} XAF, jusqu'au ${result.paidUntil.toISOString()}) — statut ${status.rawStatus}`,
    );
    return 'APPLIED';
  }

  private async applyFailure(
    payment: SubscriptionPayment,
    status: ProviderTransactionStatus,
  ): Promise<'APPLIED' | 'DUPLICATE'> {
    // Premier statut terminal gagne : un FAILED après un SUCCESS ne défait
    // rien.
    const claimed = await this.prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        failureCode: status.failureCode ?? status.rawStatus,
        failureMessage: status.failureMessage ?? null,
      },
    });
    if (claimed.count === 0) return 'DUPLICATE';
    this.logger.log(
      `👑 [PREMIUM] Paiement ${payment.id} en échec (${status.failureCode ?? status.rawStatus}) — le vendeur peut réessayer.`,
    );
    return 'APPLIED';
  }

  /**
   * Montant ou devise différents de ce qui a été demandé. Égalité stricte en
   * entiers XAF (règle 5) ; un aboutissement doit ANNONCER les deux.
   */
  private mismatch(
    status: ProviderTransactionStatus,
    payment: { amountXaf: number },
  ): string | null {
    if (status.state === 'SUCCESS') {
      if (status.currency === undefined) return 'devise non annoncée';
      if (status.amountXaf === undefined) return 'montant non annoncé';
    }
    if (status.currency !== undefined && status.currency !== 'XAF') {
      return `devise attendue XAF, reçue ${status.currency}`;
    }
    if (
      status.amountXaf !== undefined &&
      status.amountXaf !== payment.amountXaf
    ) {
      return `montant attendu ${payment.amountXaf}, annoncé ${status.amountXaf}`;
    }
    return null;
  }

  /**
   * Ouvre l'incident d'incohérence. `true` s'il vient d'être ouvert (ou n'a
   * pas pu l'être : il faut alors alerter quand même), `false` s'il l'était
   * déjà.
   */
  private async openIncident(
    payment: SubscriptionPayment,
    detail: string,
  ): Promise<boolean> {
    return this.prisma.incident
      .create({
        data: {
          type: 'OTHER',
          severity: 'CRITICAL',
          title: 'Incohérence sur un paiement d’abonnement Premium',
          description:
            `${detail}. Aucun mois accordé. ` +
            'Vérifier auprès du prestataire avant toute action manuelle.',
          restaurantId: payment.restaurantId,
          // Un seul incident ouvert par paiement : la ligne reste PENDING et
          // la réconciliation la rejoue.
          dedupKey: `subscription_payment:${payment.id}:mismatch`,
          metadata: { subscriptionPaymentId: payment.id },
        },
      })
      .then(() => true)
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          return false; // déjà ouvert
        }
        this.logger.error(
          `Incident de paiement d'abonnement non créé : ${(error as Error).message}`,
        );
        Sentry.captureException(error);
        return true;
      });
  }

  private async vendorOf(ownerId: string) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      select: { id: true, nom: true, adminApproved: true },
    });
    if (!vendor) {
      throw new ForbiddenException('Vous devez posséder une boutique.');
    }
    return vendor;
  }

  private toView(p: SubscriptionPayment): SubscriptionPaymentView {
    return {
      id: p.id,
      months: p.months,
      unitPriceXaf: p.unitPriceXaf,
      amountXaf: p.amountXaf,
      currency: p.currency,
      method: p.method,
      phoneNumber: p.phoneNumber,
      reference: p.reference,
      status: p.status,
      failureCode: p.failureCode,
      failureMessage: p.failureMessage,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
      grantedAt: p.grantedAt,
    };
  }
}

/**
 * Référence lisible sur le relevé du vendeur : `PRM` + 7 caractères sans
 * ambiguïté (ni 0/O, ni 1/I). Unique en base ; une collision (≈ 1 sur 32⁷)
 * ferait échouer la création en P2002, traité comme une tentative en cours —
 * le vendeur réessaie.
 */
function newReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(7);
  let out = 'PRM';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
