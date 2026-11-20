import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';

import { cleanCongoMobilePhone } from '../../common/validation/congo-phone.decorator';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { PrismaService } from '../../prisma/prisma.service';
import { CartLine, resolveCartLine } from '../modifiers/cart-line-pricing';
import { modifierErrorForCheckout } from '../modifiers/modifier-http';
import { ModifierSelectionError } from '../modifiers/modifier-selection';
import { OrderValidatorService } from '../orders/order-validator.service';
import { OutboxService } from '../outbox/outbox.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { hasEntitlement } from '../subscriptions/entitlements';
import { VendorSubscriptionService } from '../subscriptions/vendor-subscription.service';
import { brazzavilleClock } from '../vendors/vendor-opening.policy';
import {
  AvailabilityQueryDto,
  CreateReservationDto,
  MyReservationsQueryDto,
} from './dto/reservation-booking.dto';
import {
  arrivalInstant,
  availableSlots,
  effectiveLeadMin,
  occupancyEnd,
  parseIsoDate,
  pickSpace,
  responseDeadline,
} from './reservation-availability';
import {
  BOOKING_ERROR_CODES as CODES,
  CAPACITY_HOLDING_STATUSES,
  NO_SHOW_RESTRICTION,
  RESERVATION_ACTIVE_LIMITS,
  RESERVATION_CREATION_LIMITS,
  ReservationActiveLimit,
  ReservationStatus,
} from './reservation-booking-vocab';
import { toMinutes } from './reservation-config';
import { loadDayContext, readTogether } from './reservation-day.loader';
import { enqueueReservationNotice } from './reservation-notices';
import { ReservationOrderRelease } from './reservation-order-release';
import { indicativeLineTotals } from './reservation-order.service';
import {
  applyTransition,
  clientAllowedActions,
  isLateCancellation,
  RESERVATION_RECORD_SELECT,
  ReservationRecord,
  toClientView,
} from './reservation-records';
import {
  RESERVATION_ELIGIBLE_VENDOR_TYPE,
  RESERVATION_ENTITLEMENT,
} from './reservation-vocab';

type Db = Prisma.TransactionClient;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Borne de l'en-tête `Idempotency-Key` (un UUID en fait 36). */
const REQUEST_KEY_MAX = 100;

/**
 * Lot 4 (4B-1) — la réservation vue du client : heures libres, demande avec
 * précommande, suivi, annulation.
 *
 * - **Le serveur décide** (règle 2) : la même fonction `availableSlots`
 *   produit les heures proposées et juge la demande, rejouée sous le verrou
 *   `Restaurant` — ce qui est proposé est ce qui est accepté.
 * - **Une demande ne peut pas prendre deux fois la même table** : toute
 *   écriture qui consomme de la capacité verrouille d'abord la ligne
 *   `Restaurant` (`FOR NO KEY UPDATE`, comme la configuration du Lot 3) ; la
 *   seconde de deux demandes concurrentes relit la première et reçoit 409.
 * - **Rejouable** : `Idempotency-Key` obligatoire, unique par client en base.
 * - Aucun argent : le paiement qui confirme la table arrive en 4B-2.
 *
 * Décisions : `03-approval.md` du Lot 4.
 */
@Injectable()
export class ReservationBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly subscriptions: VendorSubscriptionService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly validator: OrderValidatorService,
    private readonly linkedOrders: ReservationOrderRelease,
  ) {}

  /**
   * Heures d'arrivée libres (public). Sans `date` : seulement les bornes, pour
   * que l'app sache si elle propose de réserver. Un restaurant absent, non
   * public ou non réservable répond le même 404 : rien ne dit pourquoi.
   */
  async availability(
    restaurantId: string,
    query: AvailabilityQueryDto,
    now: Date = new Date(),
  ) {
    const platform = await this.platformSettings.getSettings();
    const { restaurant, settings } = await this.loadBookable(
      this.prisma,
      restaurantId,
      now,
      false,
      platform.reservationsEnabled,
    );
    const leadMin = effectiveLeadMin(settings);
    const bounds = {
      restaurantId,
      maxPartySize: settings.maxPartySize,
      minLeadMin: leadMin,
      maxAdvanceDays: settings.maxAdvanceDays,
      slotDurationMin: settings.slotDurationMin,
      firstDate: brazzavilleClock(new Date(now.getTime() + leadMin * MINUTE_MS))
        .isoDate,
      lastDate: brazzavilleClock(
        new Date(now.getTime() + settings.maxAdvanceDays * DAY_MS),
      ).isoDate,
    };
    if (query.date === undefined) return bounds;
    assertDate(query.date);

    const partySize = query.partySize ?? Math.min(2, settings.maxPartySize);
    // Revue sécurité M1 : route publique — une date hors de l'horizon ne
    // charge aucun contexte (6 lectures épargnées), la réponse est la même.
    if (query.date < bounds.firstDate || query.date > bounds.lastDate) {
      return { ...bounds, date: query.date, partySize, slots: [] };
    }
    const ctx = await loadDayContext(this.prisma, {
      restaurantId,
      date: query.date,
      now,
      settings,
      pausedUntil: restaurant.pausedUntil,
      closedOnHolidays: restaurant.closedOnHolidays,
      inTransaction: false,
    });
    return {
      ...bounds,
      date: query.date,
      partySize,
      slots: availableSlots(ctx, partySize).map((s) => ({
        time: s.time,
        arrivalAt: s.arrivalAt.toISOString(),
      })),
    };
  }

  /**
   * Demande de réservation : la précommande est le **panier serveur** du
   * client (validé par les mêmes règles que le checkout), copié dans la
   * réservation puis vidé, dans la transaction qui attribue la table.
   */
  async create(
    user: Pick<User, 'id' | 'firebaseUid' | 'phone'>,
    rawKey: string | undefined,
    dto: CreateReservationDto,
    now: Date = new Date(),
  ) {
    const requestKey = assertRequestKey(rawKey);
    const replay = await this.findReplay(user.id, requestKey, dto);
    if (replay) return replay;
    try {
      return await this.createOnce(user, requestKey, dto, now);
    } catch (error) {
      // Deux envois simultanés de la même clé : le second échoue sur ce que
      // le premier vient d'écrire (plafond atteint, panier vidé, table prise,
      // unicité `(userId, requestKey)`). Si la clé a abouti, c'est la même
      // demande : on la rend (revue M1/L3 du 16/11 — sans dépendre de
      // `error.meta`, que l'adaptateur pg ne renseigne pas toujours).
      const again = await this.findReplay(user.id, requestKey, dto);
      if (again) return again;
      throw error;
    }
  }

  private async createOnce(
    user: Pick<User, 'id' | 'firebaseUid' | 'phone'>,
    requestKey: string,
    dto: CreateReservationDto,
    now: Date,
  ) {
    const contactPhone = dto.contactPhone ?? cleanCongoMobilePhone(user.phone);
    if (!contactPhone) {
      throw new BadRequestException({
        message:
          'Un numéro de téléphone est nécessaire pour réserver : le restaurant doit pouvoir vous joindre.',
        code: CODES.phoneRequired,
      });
    }
    assertDate(dto.date);
    const arrivalAt = arrivalInstant(dto.date, toMinutes(dto.time));
    await this.assertNotRestricted(user.id, now);

    // Précommande : mêmes contrôles que le checkout, hors transaction.
    const cartOwner = await this.validator.validateAndGetUser(user.firebaseUid);
    const cart = cartOwner.cart;
    const lines = cart?.items ?? [];
    if (!cart || lines.length === 0) {
      throw new BadRequestException({
        message:
          'Ajoutez au moins un plat à votre panier : la réservation se fait avec votre précommande.',
        code: CODES.cartEmpty,
      });
    }
    if (lines.some((l) => l.product.restaurantId !== dto.restaurantId)) {
      throw new BadRequestException({
        message:
          'Votre panier contient des plats d’un autre établissement. Videz-le ou réservez chez celui-ci.',
        code: CODES.cartOtherVendor,
      });
    }
    // OD-12 : on mange à l'heure d'arrivée — fenêtres horaires jugées à cette
    // heure. OD-11 : le quota du jour ne compte que pour une arrivée du jour.
    await this.validator.validateStock(lines, {
      at: arrivalAt,
      dailyStock:
        brazzavilleClock(arrivalAt).isoDate === brazzavilleClock(now).isoDate,
    });
    const cartSignature = signatureOf(lines);
    const platform = await this.platformSettings.getSettings();
    // P-04 — prix indicatif, par les fonctions de prix du checkout : il sert
    // à afficher la précommande et à signaler un écart à l'acceptation, il
    // n'est jamais facturé. Une ligne aux options devenues invalides est
    // refusée ici comme au checkout.
    const indicative = indicativePrices(lines, platform.modifiersEnabled);

    const id = await this.prisma.$transaction(
      async (tx) => {
        // Ordre des verrous, sans cycle : client → `Restaurant` → `Cart`. Le
        // checkout ne prend jamais le verrou client.
        await lockClient(tx, user.id);
        await assertActiveLimits(tx, {
          userId: user.id,
          restaurantId: dto.restaurantId,
          date: dto.date,
          now,
        });
        await assertCreationLimits(tx, {
          userId: user.id,
          restaurantId: dto.restaurantId,
          now,
        });
        await lockRestaurant(tx, dto.restaurantId);
        const { restaurant, settings } = await this.loadBookable(
          tx,
          dto.restaurantId,
          now,
          true,
          platform.reservationsEnabled,
        );
        const ctx = await loadDayContext(tx, {
          restaurantId: dto.restaurantId,
          date: dto.date,
          now,
          settings,
          pausedUntil: restaurant.pausedUntil,
          closedOnHolidays: restaurant.closedOnHolidays,
          inTransaction: true,
        });
        const offered = availableSlots(ctx, dto.partySize).some(
          (s) => s.arrivalAt.getTime() === arrivalAt.getTime(),
        );
        const space = offered
          ? pickSpace(
              ctx.spaces,
              dto.partySize,
              arrivalAt,
              settings,
              ctx.occupancies,
            )
          : null;
        if (!space) {
          throw new ConflictException({
            message:
              'Cette heure n’est plus disponible. Choisissez-en une autre.',
            code: CODES.slotUnavailable,
          });
        }

        // Le panier relu SOUS VERROU doit être celui qu'on a validé : même
        // verrou que le checkout (`lockCartAndAssertUnchanged`), si bien
        // qu'un checkout et une réservation simultanés ne consomment pas les
        // mêmes plats. Ordre sans cycle : le checkout ne prend sur
        // `Restaurant` qu'un `FOR KEY SHARE`, compatible avec notre verrou.
        await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;
        const current = await tx.cartItem.findMany({
          where: { cartId: cart.id },
          select: {
            id: true,
            quantite: true,
            variantId: true,
            menuId: true,
            optionsSignature: true,
          },
        });
        if (signatureOf(current) !== cartSignature) {
          throw new ConflictException({
            message:
              'Votre panier a changé pendant la demande. Vérifiez-le et réessayez.',
            code: CODES.cartChanged,
          });
        }

        const { endsAt, occupiedUntil } = occupancyEnd(arrivalAt, settings);
        const responseDeadlineAt = responseDeadline(now, arrivalAt);
        const created = await tx.reservation.create({
          data: {
            restaurantId: dto.restaurantId,
            userId: user.id,
            spaceId: space.id,
            partySize: dto.partySize,
            arrivalAt,
            endsAt,
            occupiedUntil,
            contactPhone,
            note: dto.note?.trim() || null,
            requestKey,
            responseDeadlineAt,
            // Même horloge que les échéances et les plafonds R-SPAM, qui
            // comptent les créations par `createdAt`.
            createdAt: now,
            indicativeSubTotal: indicative.subTotal,
            items: {
              create: lines.map((l, index) => ({
                productId: l.productId,
                menuId: l.menuId,
                variantId: l.variantId,
                quantite: l.quantite,
                optionsSignature: l.optionsSignature,
                productName: l.product.nom,
                variantLabel: l.variant?.label ?? null,
                indicativeLineTotal: indicative.lineTotals[index],
                menuName: l.menu?.nom ?? null,
                options: {
                  create: l.options.map((o) => ({
                    optionId: o.optionId,
                    quantity: o.quantity,
                    optionName: o.option.name,
                    priceDelta: o.option.priceDeltaXaf,
                  })),
                },
              })),
            },
          },
          select: { id: true },
        });
        await tx.reservationEvent.create({
          data: {
            reservationId: created.id,
            fromStatus: null,
            toStatus: 'PENDING',
            actorRole: 'CLIENT',
            actorId: user.id,
            toSpaceId: space.id,
          },
        });
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await enqueueReservationNotice(tx, this.outbox, {
          notice: 'REQUESTED',
          audience: 'VENDOR',
          recipientUserId: restaurant.ownerId,
          restaurantName: restaurant.nom,
          reservationId: created.id,
          arrivalAt: arrivalAt.toISOString(),
          partySize: dto.partySize,
        });
        return created.id;
        // ~25 allers-retours sous verrou : le défaut de 5 s de Prisma ferait
        // un 500 (P2028) au 3ᵉ ou 4ᵉ client en file sur un restaurant (revue
        // base de données M1, 16/11). Durée réelle à mesurer en préproduction.
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
    return this.getMine(user.id, id);
  }

  async listMine(userId: string, query: MyReservationsQueryDto) {
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.reservation.findMany({
        where,
        select: RESERVATION_RECORD_SELECT,
        orderBy: [{ arrivalAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.reservation.count({ where }),
    ]);
    return {
      data: rows.map((r) => toClientView(r)),
      meta: { total, page: query.page, limit: query.limit },
    };
  }

  /** Une réservation du client ; celle d'un autre répond 404 (aucune fuite). */
  async getMine(userId: string, id: string, now: Date = new Date()) {
    return toClientView(await this.findOwned(this.prisma, userId, id), now);
  }

  /**
   * Le client annule sa réservation. 4B-2 : acceptée, elle emporte sa
   * commande liée (annulée, stock rendu) ; refusée tant qu'une tentative de
   * paiement est en cours. J5 : payée, jusqu'à l'heure d'arrivée — commande
   * annulée, remboursement intégral dû (OD-07), y compris pour une annulation
   * tardive (`lateCancellation`, moins de 120 min avant : OD-08 option E).
   */
  async cancel(userId: string, id: string, now: Date = new Date()) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.findOwned(tx, userId, id);
      if (!clientAllowedActions(r, now).includes('cancel')) {
        throw actionUnavailable();
      }
      // La commande avant la réservation (ordre des verrous du paiement).
      const linked =
        r.status === 'AWAITING_PAYMENT'
          ? await this.linkedOrders.lock(tx, id)
          : null;
      this.linkedOrders.assertNoPaymentInProgress(linked);
      const paid =
        r.status === 'CONFIRMED'
          ? await this.linkedOrders.lockPaid(tx, id)
          : null;
      const late = paid !== null && isLateCancellation(r.arrivalAt, now);
      await applyTransition(tx, {
        id,
        from: r.status as ReservationStatus,
        to: 'CANCELLED_BY_CLIENT',
        actor: 'CLIENT',
        actorId: userId,
        reason: late ? 'LATE_CANCELLATION' : undefined,
        data: { cancelledAt: now, lateCancellation: late },
      });
      if (linked) {
        await this.linkedOrders.release(tx, linked, {
          actor: 'CLIENT',
          actorUserId: userId,
          source: 'APP',
          reason: 'Réservation annulée par le client avant paiement',
        });
      }
      if (paid) {
        const refundDue = await this.linkedOrders.cancelPaid(tx, paid, {
          actor: 'SYSTEM',
          actorUserId: null,
          reason: late
            ? 'Réservation annulée par le client moins de 2 h avant l’arrivée (remboursée, V1)'
            : 'Réservation annulée par le client',
          requestedBy: userId,
          vendorFault: false,
        });
        await this.outbox.enqueueInTransaction(tx, refundDue);
      }
      await enqueueReservationNotice(tx, this.outbox, {
        notice: 'CANCELLED_BY_CLIENT',
        audience: 'VENDOR',
        recipientUserId: r.restaurant.ownerId,
        restaurantName: r.restaurant.nom,
        reservationId: id,
        arrivalAt: r.arrivalAt.toISOString(),
        partySize: r.partySize,
        ...(paid ? { refundXaf: paid.total } : {}),
      });
    });
    return this.getMine(userId, id);
  }

  /**
   * Réservable = public (`PUBLIC_VENDOR_WHERE`), restaurant, réservation
   * activée, interrupteur plateforme allumé, Premium actif — relus à chaque
   * appel, jamais pris d'un cache client (03 §2).
   *
   * L'interrupteur plateforme est lu par l'appelant AVANT la transaction :
   * `getSettings()` peut ouvrir une autre connexion du pool (cache expiré),
   * ce qu'une transaction qui tient déjà la sienne et un verrou ne doit pas
   * faire (revue base de données M3, 16/11).
   */
  private async loadBookable(
    db: Db,
    restaurantId: string,
    now: Date,
    inTransaction: boolean,
    platformEnabled: boolean,
  ) {
    const restaurant = await db.restaurant.findFirst({
      where: {
        id: restaurantId,
        ...PUBLIC_VENDOR_WHERE,
        vendorType: RESERVATION_ELIGIBLE_VENDOR_TYPE,
      },
      select: {
        id: true,
        nom: true,
        ownerId: true,
        pausedUntil: true,
        closedOnHolidays: true,
      },
    });
    if (!restaurant) throw notBookable();
    const [settings, verdict] = await readTogether(inTransaction, [
      () => db.reservationSettings.findUnique({ where: { restaurantId } }),
      () => this.subscriptions.verdictFor(restaurantId, now, db),
    ] as const);
    if (
      !settings?.enabled ||
      !platformEnabled ||
      !hasEntitlement(verdict, RESERVATION_ENTITLEMENT)
    ) {
      throw notBookable();
    }
    return { restaurant, settings };
  }

  /**
   * B2 — 3 absences en 90 jours ferment la réservation 30 jours, **à
   * condition qu'elles viennent d'au moins 2 restaurants** (R-ABS, 16/11) :
   * l'absence est déclarée par le restaurant seul, sans preuve ; un
   * restaurant ne peut donc pas à lui seul fermer la réservation d'un client.
   */
  private async assertNotRestricted(userId: string, now: Date): Promise<void> {
    const noShows = await this.prisma.reservation.findMany({
      where: {
        userId,
        status: 'NO_SHOW',
        noShowAt: {
          gte: new Date(
            now.getTime() - NO_SHOW_RESTRICTION.windowDays * DAY_MS,
          ),
        },
      },
      select: { noShowAt: true, restaurantId: true },
      orderBy: { noShowAt: 'desc' },
    });
    if (noShows.length < NO_SHOW_RESTRICTION.threshold) return;
    const restaurants = new Set(noShows.map((n) => n.restaurantId)).size;
    if (restaurants < NO_SHOW_RESTRICTION.minDistinctRestaurants) return;
    const latest = noShows[0].noShowAt as Date;
    const until = new Date(
      latest.getTime() + NO_SHOW_RESTRICTION.restrictionDays * DAY_MS,
    );
    if (now < until) {
      throw new ForbiddenException({
        message: `Après ${NO_SHOW_RESTRICTION.threshold} absences en ${NO_SHOW_RESTRICTION.windowDays} jours, la réservation vous est fermée jusqu’au ${brazzavilleClock(until).isoDate}. Une erreur ? Contactez le support.`,
        code: CODES.restricted,
        until: until.toISOString(),
      });
    }
  }

  private async findReplay(
    userId: string,
    requestKey: string,
    dto: CreateReservationDto,
  ) {
    const existing = await this.prisma.reservation.findUnique({
      where: { userId_requestKey: { userId, requestKey } },
      select: RESERVATION_RECORD_SELECT,
    });
    if (!existing) return null;
    const sameRequest =
      parseIsoDate(dto.date) !== null &&
      existing.restaurantId === dto.restaurantId &&
      existing.partySize === dto.partySize &&
      existing.arrivalAt.getTime() ===
        arrivalInstant(dto.date, toMinutes(dto.time)).getTime();
    if (!sameRequest) {
      throw new ConflictException({
        message:
          'Cette clé de requête a déjà servi pour une autre réservation.',
        code: CODES.idempotencyMismatch,
      });
    }
    return toClientView(existing);
  }

  private async findOwned(
    db: Db,
    userId: string,
    id: string,
  ): Promise<ReservationRecord> {
    const r = await db.reservation.findFirst({
      where: { id, userId },
      select: RESERVATION_RECORD_SELECT,
    });
    if (!r) throw new NotFoundException('Réservation introuvable.');
    return r;
  }
}

/**
 * Verrou de toute écriture qui consomme de la capacité : `FOR NO KEY UPDATE`,
 * comme l'enregistrement de la configuration (Lot 3, ratifié R3) — il
 * sérialise les réservations d'un restaurant entre elles et avec la
 * révocation Premium, sans arrêter le `FOR KEY SHARE` d'un checkout.
 */
export async function lockRestaurant(
  tx: Db,
  restaurantId: string,
): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Restaurant" WHERE "id" = ${restaurantId} FOR NO KEY UPDATE
  `;
  if (locked.length === 0) throw notBookable();
}

/**
 * OD-01 — sérialise les demandes d'un même client : deux demandes simultanées
 * chez deux restaurants ne peuvent pas passer toutes les deux le plafond.
 * Verrou transactionnel, relâché au COMMIT/ROLLBACK ; pris en premier.
 */
async function lockClient(tx: Db, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'reservation-user:' + userId}))`;
}

const LIMIT_MESSAGES: Record<ReservationActiveLimit, string> = {
  unpaid: `Vous avez déjà ${RESERVATION_ACTIVE_LIMITS.unpaid} demandes de réservation en attente. Attendez une réponse ou annulez-en une.`,
  upcomingConfirmed: `Vous avez déjà ${RESERVATION_ACTIVE_LIMITS.upcomingConfirmed} réservations confirmées à venir.`,
  perRestaurantPerDay:
    'Vous avez déjà une réservation dans cet établissement ce jour-là.',
};

/** OD-01 — les trois plafonds, relus sous le verrou client. */
async function assertActiveLimits(
  tx: Db,
  p: { userId: string; restaurantId: string; date: string; now: Date },
): Promise<void> {
  const dayStart = arrivalInstant(p.date, 0);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const [unpaid, upcomingConfirmed, perRestaurantPerDay] = await readTogether(
    true,
    [
      () =>
        tx.reservation.count({
          where: {
            userId: p.userId,
            OR: [
              { status: 'PENDING', responseDeadlineAt: { gt: p.now } },
              { status: 'AWAITING_PAYMENT' },
            ],
          },
        }),
      () =>
        tx.reservation.count({
          where: {
            userId: p.userId,
            status: 'CONFIRMED',
            arrivalAt: { gt: p.now },
          },
        }),
      () =>
        tx.reservation.count({
          where: {
            userId: p.userId,
            restaurantId: p.restaurantId,
            status: { in: [...CAPACITY_HOLDING_STATUSES] },
            arrivalAt: { gte: dayStart, lt: dayEnd },
          },
        }),
    ] as const,
  );
  const counts: Record<ReservationActiveLimit, number> = {
    unpaid,
    upcomingConfirmed,
    perRestaurantPerDay,
  };
  const reached = (
    Object.keys(RESERVATION_ACTIVE_LIMITS) as ReservationActiveLimit[]
  ).find((k) => counts[k] >= RESERVATION_ACTIVE_LIMITS[k]);
  if (reached) {
    throw new ConflictException({
      message: LIMIT_MESSAGES[reached],
      code: CODES.activeLimit,
      limit: reached,
      max: RESERVATION_ACTIVE_LIMITS[reached],
    });
  }
}

/**
 * R-SPAM (16/11) — demandes créées sur 24 h glissantes, annulées comprises :
 * créer puis annuler en boucle ne libère pas le compteur (chaque demande
 * notifie le restaurant et tient une table). Sous le verrou client.
 */
async function assertCreationLimits(
  tx: Db,
  p: { userId: string; restaurantId: string; now: Date },
): Promise<void> {
  const L = RESERVATION_CREATION_LIMITS;
  const since = new Date(p.now.getTime() - L.windowHours * 60 * MINUTE_MS);
  const [total, perRestaurant] = await readTogether(true, [
    () =>
      tx.reservation.count({
        where: { userId: p.userId, createdAt: { gte: since } },
      }),
    () =>
      tx.reservation.count({
        where: {
          userId: p.userId,
          restaurantId: p.restaurantId,
          createdAt: { gte: since },
        },
      }),
  ] as const);
  if (total >= L.total || perRestaurant >= L.perRestaurant) {
    throw new ConflictException({
      message:
        total >= L.total
          ? `Vous avez déjà fait ${L.total} demandes de réservation en 24 h. Réessayez plus tard.`
          : `Vous avez déjà fait ${L.perRestaurant} demandes dans cet établissement en 24 h. Réessayez plus tard.`,
      code: CODES.creationLimit,
      limit: total >= L.total ? 'total' : 'perRestaurant',
    });
  }
}

function notBookable(): NotFoundException {
  return new NotFoundException({
    message: 'Ce restaurant ne prend pas de réservation en ligne.',
    code: CODES.notBookable,
  });
}

function actionUnavailable(): ConflictException {
  return new ConflictException({
    message:
      'Cette réservation ne peut plus être annulée depuis l’application.',
    code: CODES.actionUnavailable,
  });
}

function assertDate(date: string): void {
  if (!parseIsoDate(date)) {
    throw new BadRequestException({
      message: 'Date invalide.',
      code: CODES.invalidDate,
    });
  }
}

function assertRequestKey(raw: string | undefined): string {
  const key = raw?.trim();
  if (!key || key.length > REQUEST_KEY_MAX) {
    throw new BadRequestException(
      'En-tête Idempotency-Key requis (une valeur par demande de réservation).',
    );
  }
  return key;
}

/** P-04 — sous-total et part de chaque ligne, indicatifs (jamais facturés). */
function indicativePrices(
  lines: readonly CartLine[],
  modifiersEnabled: boolean,
): { subTotal: number; lineTotals: number[] } {
  const priced = lines.map((line) => {
    try {
      return { line, selection: resolveCartLine(line, modifiersEnabled) };
    } catch (err) {
      if (err instanceof ModifierSelectionError) {
        throw modifierErrorForCheckout(err, line.id);
      }
      throw err;
    }
  });
  const lineTotals = indicativeLineTotals(priced);
  return {
    subTotal: lineTotals.reduce((sum, total) => sum + total, 0),
    lineTotals,
  };
}

/** Empreinte d'un panier : identité et quantité de chaque ligne. */
function signatureOf(
  lines: ReadonlyArray<{
    id: string;
    quantite: number;
    variantId: string;
    menuId: string | null;
    optionsSignature: string;
  }>,
): string {
  return [...lines]
    .map(
      (l) =>
        `${l.id}:${l.quantite}:${l.variantId}:${l.menuId ?? ''}:${l.optionsSignature}`,
    )
    .sort()
    .join('|');
}
