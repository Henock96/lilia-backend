import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  DeliveryStatus,
  DispatchEndReason,
  DispatchOutcome,
  OrderStatus,
  OutboxEvent,
  Prisma,
  Role,
} from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { CronLockService } from '../../../common/locks/cron-lock.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { OutboxService } from '../../outbox/outbox.service';
import { OutboxDispatcherService } from '../../outbox/outbox-dispatcher.service';
import { ACTIVE_DELIVERY_STATUSES } from '../delivery-statuses';
import { CLEARED_DRIVER_ECONOMICS } from '../delivery-assignment.service';
import {
  CLAIMABLE_DELIVERY_WHERE,
  DELIVERY_DISPATCH_REQUESTED_EVENT,
  FCFS_MAX_ROUNDS,
  FCFS_PRESENCE_WINDOW_MS,
  FCFS_ROUND_INTERVAL_MS,
  PUSH_DELIVERY_OFFER,
  PUSH_DELIVERY_OFFER_TAKEN,
  closedDispatchData,
  dispatchStateOf,
  isDispatchOpen,
  offerCollapseKey,
  openedDispatchData,
  readDispatchEnabled,
} from './dispatch-policy';
import {
  driverAccountWhere,
  driverAvailabilityWhere,
  driverIneligibility,
  eligibleDriverWhere,
  restaurantZoneWhere,
} from './dispatch-eligibility';
import {
  OFFER_SELECT,
  projectOfferForDriver,
} from './delivery-offer-projection';

/** Recherche ouverte dans une transaction, à lancer après son commit. */
export interface OpenedDispatch {
  deliveryId: string;
  orderId: string;
  outboxId: string;
}

/** Charge utile de `delivery.dispatch_requested`. */
export interface DispatchRequestedPayload {
  deliveryId: string;
  orderId: string;
  cause: 'ORDER_READY' | 'DRIVER_ABANDONED' | 'ADMIN_REDISPATCH';
  /** `User.id` de l'administrateur, pour une relance : la trace du geste. */
  requestedBy?: string;
}

export type RoundResult =
  | 'BROADCAST'
  | 'NOT_DUE'
  | 'EXHAUSTED'
  | 'CLOSED'
  | 'GONE';

const OFFER_TITLE = 'Nouvelle livraison disponible !';
const OFFER_BODY =
  'Une nouvelle commande est prête à être récupérée. Consultez les détails et acceptez-la si vous êtes disponible.';

/** Colonnes lues pour décider d'un tour de diffusion. */
const ROUND_SELECT = {
  id: true,
  orderId: true,
  status: true,
  delivererId: true,
  dispatchStartedAt: true,
  dispatchDueAt: true,
  dispatchEndedAt: true,
  dispatchOutcome: true,
  dispatchRound: true,
  dispatchNotifiedCount: true,
  order: {
    select: {
      status: true,
      isDelivery: true,
      restaurant: { select: { quartierId: true } },
    },
  },
} satisfies Prisma.DeliverySelect;

/** Vue « recherche » d'une course, pour la supervision et le verdict. */
const VIEW_SELECT = {
  id: true,
  orderId: true,
  status: true,
  createdAt: true,
  acceptedAt: true,
  pickedUpAt: true,
  dispatchStartedAt: true,
  dispatchDueAt: true,
  dispatchEndedAt: true,
  dispatchOutcome: true,
  dispatchEndReason: true,
  dispatchRound: true,
  dispatchNotifiedCount: true,
  deliverer: { select: { id: true, nom: true, phone: true } },
  order: {
    select: {
      id: true,
      status: true,
      isDelivery: true,
      restaurant: {
        select: { id: true, nom: true, quartier: { select: { nom: true } } },
      },
    },
  },
} satisfies Prisma.DeliverySelect;

type ViewRow = Prisma.DeliveryGetPayload<{ select: typeof VIEW_SELECT }>;

/**
 * Dispatch FCFS : ouvre les recherches, diffuse les tours, relance, liste les
 * courses ouvertes. **N'attribue jamais** une course : seul le claim d'un
 * livreur le fait (`DeliveryClaimService`).
 *
 * Chargé par le web ET par le worker (`DispatchCoreModule`) : le cron des
 * tours et le traitement outbox tournent là où `RUN_BACKGROUND_JOBS` le
 * permet, sous `CronLockService`. Le chemin rapide (diffusion juste après le
 * commit du passage à PRET) tourne dans le processus web.
 *
 * Doublons de diffusion : impossibles par construction. Chaque tour est
 * revendiqué en CAS sur `dispatchRound` — le chemin rapide, l'outbox et le
 * cron peuvent arriver ensemble, un seul envoie.
 */
@Injectable()
export class DeliveryDispatchService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly cronLock: CronLockService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler(DELIVERY_DISPATCH_REQUESTED_EVENT, (e) =>
      this.handleDispatchRequested(e),
    );
  }

  // ─── Ouverture ────────────────────────────────────────────────────────────

  /**
   * Ouvre la recherche d'une commande à livrer qui passe `PRET`, **dans la
   * transaction de la transition** : statut, course et obligation de
   * diffuser naissent ensemble ou pas du tout.
   *
   * Idempotent : `INSERT … ON CONFLICT DO NOTHING` sur `Delivery.orderId`.
   * Une course qui a déjà un titulaire (assignation antérieure à PRET) est
   * laissée telle quelle — son livreur est prévenu par le chemin existant.
   *
   * @returns la recherche ouverte, ou `null` (interrupteur éteint, course
   *          déjà tenue ou déjà en recherche).
   */
  async openInTransaction(
    tx: Prisma.TransactionClient,
    orderId: string,
    now: Date = new Date(),
  ): Promise<OpenedDispatch | null> {
    if (!(await readDispatchEnabled(tx))) return null;

    const created = await tx.delivery.createMany({
      data: [
        {
          orderId,
          status: DeliveryStatus.EN_ATTENTE,
          ...openedDispatchData(now),
        },
      ],
      skipDuplicates: true,
    });

    const delivery = await tx.delivery.findUniqueOrThrow({
      where: { orderId },
      select: {
        id: true,
        status: true,
        delivererId: true,
        dispatchStartedAt: true,
        dispatchEndedAt: true,
        dispatchOutcome: true,
      },
    });

    if (created.count === 0) {
      // Course préexistante : on ne rouvre qu'une course sans titulaire et
      // sans recherche en cours.
      if (
        delivery.delivererId !== null ||
        delivery.status !== DeliveryStatus.EN_ATTENTE ||
        isDispatchOpen(delivery)
      ) {
        return null;
      }
      const reopened = await tx.delivery.updateMany({
        where: {
          id: delivery.id,
          status: DeliveryStatus.EN_ATTENTE,
          delivererId: null,
          dispatchStartedAt: delivery.dispatchStartedAt,
          dispatchEndedAt: delivery.dispatchEndedAt,
        },
        data: openedDispatchData(now),
      });
      if (reopened.count === 0) return null;
    }

    const outboxId = await this.outbox.enqueueInTransaction(tx, {
      type: DELIVERY_DISPATCH_REQUESTED_EVENT,
      aggregateId: delivery.id,
      payload: {
        deliveryId: delivery.id,
        orderId,
        cause: 'ORDER_READY',
      } satisfies DispatchRequestedPayload,
    });
    return { deliveryId: delivery.id, orderId, outboxId };
  }

  /**
   * Après le commit : premier tour tout de suite (latence), puis acquittement
   * de l'outbox. Une erreur ici n'est jamais remontée à l'appelant — le
   * vendeur a bien passé sa commande `PRET` — : l'outbox et le cron
   * reprendront.
   */
  async afterOpen(opened: OpenedDispatch): Promise<void> {
    try {
      await this.runRound(opened.deliveryId);
      await this.outbox.markSent(opened.outboxId);
    } catch (err) {
      this.logger.error(
        `Diffusion immédiate échouée pour la course ${opened.deliveryId} — reprise par l'outbox : ${(err as Error).message}`,
      );
    }
  }

  private async handleDispatchRequested(event: OutboxEvent): Promise<void> {
    const payload = event.payload as unknown as DispatchRequestedPayload;
    await this.runRound(payload.deliveryId);
    await this.outbox.markSent(event.id);
  }

  // ─── Tours de diffusion ──────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'dispatch-rounds' })
  async tick(): Promise<void> {
    await this.cronLock.runExclusively('dispatch-rounds', 60, () =>
      this.runDueRounds(),
    );
  }

  /** Toutes les recherches dont le prochain tour est dû. */
  async runDueRounds(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.delivery.findMany({
      where: {
        dispatchStartedAt: { not: null },
        dispatchEndedAt: null,
        dispatchDueAt: { lte: now },
      },
      orderBy: { dispatchDueAt: 'asc' },
      select: { id: true },
      take: 50,
    });
    for (const { id } of due) {
      await this.runRound(id, now).catch((err) =>
        this.logger.error(
          `Tour de diffusion échoué pour la course ${id} : ${(err as Error).message}`,
        ),
      );
    }
    return due.length;
  }

  /**
   * Un tour : ferme la recherche si elle n'a plus d'objet, l'épuise après
   * `FCFS_MAX_ROUNDS` diffusions, sinon revendique le tour suivant et
   * notifie les livreurs éligibles **du moment** (recalculés à chaque tour).
   */
  async runRound(
    deliveryId: string,
    now: Date = new Date(),
  ): Promise<RoundResult> {
    const d = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: ROUND_SELECT,
    });
    if (!d || !isDispatchOpen(d)) return 'GONE';

    if (d.order.status !== OrderStatus.PRET || !d.order.isDelivery) {
      return this.close(d.id, now, DispatchOutcome.ORDER_CLOSED);
    }
    // Course prise ou sortie d'attente par un autre chemin (échec déclaré
    // par le vendeur, assignation historique…) : plus rien à proposer.
    if (d.status !== DeliveryStatus.EN_ATTENTE || d.delivererId !== null) {
      return this.close(d.id, now, DispatchOutcome.STOPPED);
    }
    if (!(await readDispatchEnabled(this.prisma))) {
      return this.close(d.id, now, DispatchOutcome.STOPPED);
    }
    if (d.dispatchDueAt && d.dispatchDueAt > now) return 'NOT_DUE';

    const round = d.dispatchRound ?? 0;
    if (round >= FCFS_MAX_ROUNDS) {
      const exhausted = await this.prisma.delivery.updateMany({
        where: {
          id: d.id,
          ...CLAIMABLE_DELIVERY_WHERE,
          dispatchRound: d.dispatchRound,
        },
        data: closedDispatchData(
          now,
          DispatchOutcome.EXHAUSTED,
          d.dispatchNotifiedCount
            ? DispatchEndReason.ROUNDS_EXHAUSTED
            : DispatchEndReason.NO_CANDIDATE,
        ),
      });
      if (exhausted.count === 0) return 'NOT_DUE';
      // L'alerte humaine passe par le cockpit (`dispatch_exhausted`, file
      // SLA : incident + alerte administrateur par `OpsSlaScanService`).
      this.logger.warn(
        `🛵 Recherche épuisée pour la commande ${d.orderId} après ${round} diffusion(s) — relance humaine requise`,
      );
      return 'EXHAUSTED';
    }

    // Le CAS du tour : seul celui qui fait passer `dispatchRound` de r à r+1
    // diffuse. Les autres (cron, outbox, chemin rapide) repartent sans rien.
    const claimed = await this.prisma.delivery.updateMany({
      where: {
        id: d.id,
        ...CLAIMABLE_DELIVERY_WHERE,
        dispatchRound: d.dispatchRound,
        dispatchDueAt: { lte: now },
      },
      data: {
        dispatchRound: round + 1,
        dispatchDueAt: new Date(now.getTime() + FCFS_ROUND_INTERVAL_MS),
      },
    });
    if (claimed.count === 0) return 'NOT_DUE';

    const drivers = await this.eligibleDriverIds(
      d.order.restaurant.quartierId,
      new Date(now.getTime() - FCFS_PRESENCE_WINDOW_MS),
    );
    await this.prisma.delivery.updateMany({
      where: { id: d.id, dispatchRound: round + 1 },
      data: { dispatchNotifiedCount: drivers.length },
    });

    if (drivers.length > 0) {
      // Le push est un confort : son échec ne défait pas le tour (la liste
      // reste la vérité, et le tour suivant renotifiera).
      await this.notifications
        .sendPushToUsers(
          drivers,
          OFFER_TITLE,
          OFFER_BODY,
          {
            type: PUSH_DELIVERY_OFFER,
            openDeliveryId: d.id,
            round: String(round + 1),
          },
          { collapseKey: offerCollapseKey(d.id) },
        )
        .catch((err) =>
          this.logger.error(
            `Push d'offre échoué pour la course ${d.id} : ${(err as Error).message}`,
          ),
        );
    }
    this.logger.log(
      `🛵 Diffusion ${round + 1}/${FCFS_MAX_ROUNDS} de la course ${d.id} — ${drivers.length} livreur(s)`,
    );
    return 'BROADCAST';
  }

  private async close(
    deliveryId: string,
    now: Date,
    outcome: DispatchOutcome,
  ): Promise<RoundResult> {
    await this.prisma.delivery.updateMany({
      where: {
        id: deliveryId,
        dispatchStartedAt: { not: null },
        dispatchEndedAt: null,
      },
      data: closedDispatchData(now, outcome),
    });
    return 'CLOSED';
  }

  /** Livreurs à notifier pour une boutique (règle unique d'éligibilité). */
  async eligibleDriverIds(
    restaurantQuartierId: string | null,
    presentSince?: Date,
  ): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: eligibleDriverWhere(restaurantQuartierId, { presentSince }),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ─── Diffusions ciblées ──────────────────────────────────────────────────

  /**
   * Un livreur vient de passer `AVAILABLE` : on lui propose les courses déjà
   * ouvertes de ses zones, sans attendre le prochain tour. Ne touche à aucun
   * compteur de tour. Best effort : la liste reste la vérité.
   */
  async offerOpenDeliveriesTo(driverId: string): Promise<number> {
    if (!(await readDispatchEnabled(this.prisma))) return 0;
    const driver = await this.prisma.user.findFirst({
      where: {
        AND: [
          { id: driverId },
          driverAccountWhere(),
          driverAvailabilityWhere(),
          {
            driverProfile: {
              is: { isActive: true, offersEnabledAt: { not: null } },
            },
          },
        ],
      },
      select: {
        driverProfile: { select: { zones: { select: { id: true } } } },
      },
    });
    if (!driver?.driverProfile) return 0;

    const where = this.openDeliveriesWhere(
      driver.driverProfile.zones.map((z) => z.id),
    );
    const [count, first] = await Promise.all([
      this.prisma.delivery.count({ where }),
      this.prisma.delivery.findFirst({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
    ]);
    if (!first) return 0;

    await this.notifications.sendPushToUsers(
      [driverId],
      count === 1 ? OFFER_TITLE : `${count} livraisons disponibles !`,
      count === 1
        ? OFFER_BODY
        : 'Des commandes sont prêtes à être récupérées. Consultez-les et acceptez celle qui vous convient.',
      { type: PUSH_DELIVERY_OFFER, openDeliveryId: first.id },
      { collapseKey: offerCollapseKey(first.id) },
    );
    return count;
  }

  /**
   * « Cette course n'est plus disponible » : message de données seul, pour
   * que les apps ouvertes retirent la carte sans attendre leur prochaine
   * synchronisation. Best effort — le claim reste l'arbitre (409).
   */
  async announceOfferWithdrawn(
    deliveryId: string,
    restaurantQuartierId: string | null,
    reason: 'ASSIGNED' | 'ORDER_CLOSED',
    exceptDriverId?: string,
  ): Promise<void> {
    const drivers = (
      await this.eligibleDriverIds(
        restaurantQuartierId,
        new Date(Date.now() - FCFS_PRESENCE_WINDOW_MS),
      )
    ).filter((id) => id !== exceptDriverId);
    if (drivers.length === 0) return;
    await this.notifications.sendPushToUsers(
      drivers,
      '',
      '',
      { type: PUSH_DELIVERY_OFFER_TAKEN, openDeliveryId: deliveryId, reason },
      { collapseKey: offerCollapseKey(deliveryId), dataOnly: true },
    );
  }

  /**
   * Après une annulation : si la transition vient de fermer une recherche,
   * les livreurs qui la voyaient sont prévenus.
   */
  async announceClosedForOrder(orderId: string): Promise<void> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
      select: {
        id: true,
        dispatchOutcome: true,
        dispatchEndedAt: true,
        order: { select: { restaurant: { select: { quartierId: true } } } },
      },
    });
    if (
      !delivery ||
      delivery.dispatchOutcome !== DispatchOutcome.ORDER_CLOSED ||
      !delivery.dispatchEndedAt ||
      Date.now() - delivery.dispatchEndedAt.getTime() > 2 * 60_000
    ) {
      return;
    }
    await this.announceOfferWithdrawn(
      delivery.id,
      delivery.order.restaurant.quartierId,
      'ORDER_CLOSED',
    );
  }

  // ─── Liste du livreur ────────────────────────────────────────────────────

  private openDeliveriesWhere(zoneIds: string[]): Prisma.DeliveryWhereInput {
    return {
      ...CLAIMABLE_DELIVERY_WHERE,
      order: {
        status: OrderStatus.PRET,
        isDelivery: true,
        ...restaurantZoneWhere(zoneIds),
      },
    };
  }

  /**
   * `GET /deliveries/available` — les courses que CE livreur peut accepter,
   * de la plus ancienne à la plus récente. Un livreur non éligible reçoit une
   * liste vide et la raison (`meta.driver.reason`), que l'app affiche.
   */
  async listOpenForDriver(userId: string, page = 1, limit = 20) {
    const [enabled, driver] = await Promise.all([
      readDispatchEnabled(this.prisma),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          role: true,
          statusUser: true,
          banPendingAt: true,
          driverStatus: true,
          driverProfile: {
            select: {
              isActive: true,
              offersEnabledAt: true,
              zones: { select: { id: true } },
            },
          },
          _count: {
            select: {
              deliveries: {
                where: { status: { in: ACTIVE_DELIVERY_STATUSES } },
              },
            },
          },
        },
      }),
    ]);
    if (!driver) throw new NotFoundException('Utilisateur non trouvé.');

    const reason = driverIneligibility(
      {
        role: driver.role,
        statusUser: driver.statusUser,
        banPendingAt: driver.banPendingAt,
        driverStatus: driver.driverStatus,
        profile: driver.driverProfile,
        activeDeliveries: driver._count.deliveries,
      },
      enabled,
    );
    const meta = (total: number) => ({
      page,
      limit,
      total,
      hasMore: page * limit < total,
      dispatchEnabled: enabled,
      driver: {
        eligible: reason === null,
        reason,
        driverStatus: driver.driverStatus,
      },
    });
    if (reason !== null) return { data: [], count: 0, meta: meta(0) };

    const where = this.openDeliveriesWhere(
      driver.driverProfile!.zones.map((z) => z.id),
    );
    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        select: OFFER_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.delivery.count({ where }),
    ]);
    const quartierIds = [
      ...new Set(
        rows
          .map((r) => r.order.deliveryQuartierId)
          .filter((id): id is string => !!id),
      ),
    ];
    const quartiers = quartierIds.length
      ? await this.prisma.quartier.findMany({
          where: { id: { in: quartierIds } },
          select: { id: true, nom: true },
        })
      : [];
    const names = new Map(quartiers.map((q) => [q.id, q.nom]));
    return {
      data: rows.map((r) => projectOfferForDriver(r, names)),
      count: rows.length,
      meta: meta(total),
    };
  }

  // ─── Vendeur et administration ───────────────────────────────────────────

  /**
   * Verdict serveur pour les écrans vendeur et admin d'une commande :
   * l'assignation manuelle est-elle permise, et où en est la recherche ?
   * (Décision du 10/11 : le bouton d'assignation suit `manualAssignmentAllowed`
   * et disparaît de lui-même à l'activation.) Jamais exposé au client.
   */
  async orderDispatchView(orderId: string, viewerId: string) {
    const [viewer, order, settings] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: viewerId },
        select: { id: true, role: true },
      }),
      this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          isDelivery: true,
          restaurant: { select: { ownerId: true } },
          delivery: { select: VIEW_SELECT },
        },
      }),
      this.prisma.platformSettings.findUnique({
        where: { id: 'singleton' },
        select: { dispatchEnabled: true, vendorCanAssignDriver: true },
      }),
    ]);
    if (!order) throw new NotFoundException('Commande non trouvée.');
    const isAdmin = viewer?.role === Role.ADMIN;
    if (!isAdmin && order.restaurant.ownerId !== viewerId) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à consulter cette commande.",
      );
    }
    const enabled = settings?.dispatchEnabled === true;
    const vendorMayAssign = settings?.vendorCanAssignDriver !== false;
    const delivery = order.delivery;

    return {
      data: {
        orderId: order.id,
        isDelivery: order.isDelivery,
        mode: enabled ? 'AUTOMATIC' : 'MANUAL',
        manualAssignmentAllowed:
          order.isDelivery && !enabled && (isAdmin || vendorMayAssign),
        redispatchAllowed:
          isAdmin && enabled && this.canRedispatch(order, delivery),
        maxRounds: FCFS_MAX_ROUNDS,
        roundIntervalSeconds: FCFS_ROUND_INTERVAL_MS / 1000,
        ...(delivery
          ? this.dispatchView(delivery)
          : { deliveryId: null, state: 'NONE' }),
      },
    };
  }

  private canRedispatch(
    order: { status: OrderStatus; isDelivery: boolean },
    delivery: Pick<
      ViewRow,
      | 'status'
      | 'deliverer'
      | 'dispatchStartedAt'
      | 'dispatchEndedAt'
      | 'dispatchOutcome'
      | 'pickedUpAt'
    > | null,
  ): boolean {
    if (order.status !== OrderStatus.PRET || !order.isDelivery) return false;
    if (!delivery) return true;
    if (delivery.deliverer !== null || delivery.pickedUpAt !== null) {
      return false;
    }
    if (delivery.status === DeliveryStatus.ECHEC) return true;
    return (
      delivery.status === DeliveryStatus.EN_ATTENTE && !isDispatchOpen(delivery)
    );
  }

  private dispatchView(d: Omit<ViewRow, 'order'>) {
    const state = dispatchStateOf(d);
    const since = d.dispatchStartedAt;
    const until = d.dispatchEndedAt ?? new Date();
    return {
      deliveryId: d.id,
      deliveryStatus: d.status,
      state,
      startedAt: since?.toISOString() ?? null,
      nextRoundAt:
        state === 'SEARCHING' ? (d.dispatchDueAt?.toISOString() ?? null) : null,
      endedAt: d.dispatchEndedAt?.toISOString() ?? null,
      outcome: d.dispatchOutcome,
      endReason: d.dispatchEndReason,
      round: d.dispatchRound ?? 0,
      notifiedCount: d.dispatchNotifiedCount ?? 0,
      waitingSeconds: since
        ? Math.max(0, Math.round((until.getTime() - since.getTime()) / 1000))
        : null,
      acceptedAt: d.acceptedAt?.toISOString() ?? null,
      deliverer: d.deliverer
        ? { id: d.deliverer.id, nom: d.deliverer.nom }
        : null,
    };
  }

  /** `GET /admin/deliveries/dispatch` — supervision des recherches. */
  async supervision(now: Date = new Date()) {
    const take = 50;
    const [enabled, open, exhausted, assigned, failedBeforePickup] =
      await Promise.all([
        readDispatchEnabled(this.prisma),
        this.prisma.delivery.findMany({
          where: { dispatchStartedAt: { not: null }, dispatchEndedAt: null },
          orderBy: { dispatchStartedAt: 'asc' },
          select: VIEW_SELECT,
          take,
        }),
        this.prisma.delivery.findMany({
          where: {
            dispatchOutcome: DispatchOutcome.EXHAUSTED,
            status: DeliveryStatus.EN_ATTENTE,
            delivererId: null,
            order: { status: OrderStatus.PRET },
          },
          orderBy: { dispatchStartedAt: 'asc' },
          select: VIEW_SELECT,
          take,
        }),
        this.prisma.delivery.findMany({
          where: {
            dispatchOutcome: DispatchOutcome.ASSIGNED,
            dispatchEndedAt: { gte: new Date(now.getTime() - 24 * 3600_000) },
          },
          orderBy: { dispatchEndedAt: 'desc' },
          select: VIEW_SELECT,
          take,
        }),
        this.prisma.delivery.findMany({
          where: {
            status: DeliveryStatus.ECHEC,
            delivererId: null,
            order: { status: OrderStatus.PRET, isDelivery: true },
          },
          orderBy: { updatedAt: 'asc' },
          select: VIEW_SELECT,
          take,
        }),
      ]);

    const item = (d: ViewRow) => ({
      ...this.dispatchView(d),
      orderId: d.orderId,
      orderRef: `#${d.orderId.slice(-6).toUpperCase()}`,
      orderStatus: d.order.status,
      restaurant: {
        id: d.order.restaurant.id,
        nom: d.order.restaurant.nom,
        quartier: d.order.restaurant.quartier?.nom ?? null,
      },
      // L'administration voit le téléphone du livreur attribué : c'est elle
      // qui appelle quand une course tarde.
      deliverer: d.deliverer,
      redispatchAllowed: enabled && this.canRedispatch(d.order, d),
    });

    return {
      data: {
        enabled,
        maxRounds: FCFS_MAX_ROUNDS,
        roundIntervalSeconds: FCFS_ROUND_INTERVAL_MS / 1000,
        open: open.map(item),
        exhausted: exhausted.map(item),
        assigned: assigned.map(item),
        failedBeforePickup: failedBeforePickup.map(item),
      },
    };
  }

  /**
   * `POST /admin/deliveries/:id/redispatch` — relance une recherche, **sans
   * jamais choisir de livreur** : la course redevient `EN_ATTENTE`, sans
   * titulaire, et les tours repartent de zéro.
   *
   * Permise sur une commande `PRET` à livrer dont la course n'a pas de
   * titulaire et n'est pas en recherche : recherche épuisée ou arrêtée,
   * jamais ouverte (commande prête avant l'activation), ou échec déclaré
   * avant la récupération (F3-05 — sans elle, la commande resterait bloquée
   * puisque l'assignation manuelle n'existe plus).
   */
  async redispatch(deliveryId: string, adminId: string) {
    const head = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { orderId: true },
    });
    if (!head) throw new NotFoundException('Course introuvable.');
    return this.redispatchOrder(head.orderId, adminId);
  }

  /**
   * Même geste, par la commande : une commande passée `PRET` AVANT
   * l'activation n'a pas de course, donc pas d'identifiant à relancer. La
   * course est créée ici, dans la transaction, sans titulaire.
   */
  async redispatchOrder(orderId: string, adminId: string) {
    const now = new Date();
    const opened = await this.prisma.$transaction(async (tx) => {
      // R1 avant R2, comme le claim : une annulation concurrente attend.
      const [order] = await tx.$queryRaw<
        { status: OrderStatus; isDelivery: boolean }[]
      >`
        SELECT status, "isDelivery" FROM "Order" WHERE id = ${orderId} FOR SHARE
      `;
      if (!order) throw new NotFoundException('Commande non trouvée.');
      if (!(await readDispatchEnabled(tx))) {
        throw new ConflictException({
          code: 'DISPATCH_DISABLED',
          message:
            'Le dispatch automatique est éteint : aucune recherche ne peut être relancée.',
        });
      }
      if (order.status === OrderStatus.PRET && order.isDelivery) {
        await tx.delivery.createMany({
          data: [{ orderId, status: DeliveryStatus.EN_ATTENTE }],
          skipDuplicates: true,
        });
      }
      const d = await tx.delivery.findUnique({
        where: { orderId },
        select: VIEW_SELECT,
      });
      if (!d) {
        throw new ConflictException({
          code: 'REDISPATCH_NOT_ALLOWED',
          message: 'Cette commande n’est pas une livraison prête.',
        });
      }
      const deliveryId = d.id;
      if (!this.canRedispatch(order, d)) {
        throw new ConflictException({
          code: 'REDISPATCH_NOT_ALLOWED',
          message: isDispatchOpen(d)
            ? 'Une recherche est déjà en cours pour cette commande.'
            : 'Cette course ne peut pas être relancée (livreur attribué ou commande plus prête).',
        });
      }
      const reset = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          status: d.status,
          delivererId: null,
          pickedUpAt: null,
          dispatchStartedAt: d.dispatchStartedAt,
          dispatchEndedAt: d.dispatchEndedAt,
        },
        data: {
          status: DeliveryStatus.EN_ATTENTE,
          // D-3 — seul celui qui termine est payé : une course remise en jeu
          // ne garde rien de la main précédente.
          acceptedAt: null,
          ...CLEARED_DRIVER_ECONOMICS,
          ...openedDispatchData(now),
        },
      });
      if (reset.count === 0) {
        throw new ConflictException(
          'Cette course vient de changer. Rechargez avant de relancer.',
        );
      }
      const outboxId = await this.outbox.enqueueInTransaction(tx, {
        type: DELIVERY_DISPATCH_REQUESTED_EVENT,
        aggregateId: deliveryId,
        payload: {
          deliveryId,
          orderId,
          cause: 'ADMIN_REDISPATCH',
          requestedBy: adminId,
        } satisfies DispatchRequestedPayload,
      });
      return { deliveryId, orderId, outboxId };
    });

    this.logger.log(
      `🛵 Recherche relancée par l'administrateur ${adminId} pour la course ${opened.deliveryId}`,
    );
    await this.afterOpen(opened);
    return {
      data: { deliveryId: opened.deliveryId, state: 'SEARCHING' },
      message: 'Recherche relancée : les livreurs disponibles sont notifiés.',
    };
  }
}
