import {
  DeliveryStatus,
  DispatchEndReason,
  DispatchOutcome,
  Prisma,
} from '@prisma/client';

/**
 * Dispatch FCFS — « premier arrivé, premier servi » (10/11/2026).
 *
 * Règles du métier réunies ici, et nulle part ailleurs : le service, le cron,
 * la supervision et les tests lisent les mêmes. Décisions de la demande du
 * 10/11 (Q6) : une diffusion toutes les 3 minutes, cinq au plus, puis la
 * recherche s'épuise — la commande reste `PRET`, rien n'est annulé.
 */
export const FCFS_MAX_ROUNDS = 5;
export const FCFS_ROUND_INTERVAL_MS = 3 * 60_000;

/**
 * Fenêtre de présence (Q7). Un livreur `AVAILABLE` dont l'app n'a pas
 * renouvelé sa capacité depuis 12 h n'est plus **notifié** : l'app est
 * probablement fermée. Son statut n'est pas touché (invariant R5) — il voit
 * toujours la liste et peut toujours accepter s'il rouvre l'app.
 */
export const FCFS_PRESENCE_WINDOW_MS = 12 * 60 * 60_000;

/**
 * `DeliveryAssignment.assignedByRole` d'une main prise par le dispatch :
 * aucun humain n'a assigné (`assignedByUserId = null`).
 */
export const FCFS_ASSIGNED_BY_ROLE = 'DISPATCH';

/** Événement outbox écrit dans la transaction du passage à `PRET`. */
export const DELIVERY_DISPATCH_REQUESTED_EVENT = 'delivery.dispatch_requested';

/**
 * Types de push. ⚠️ Aucun ne porte la clé `deliveryId` : l'app livreur
 * installée ouvre `/deliveries/:id` pour tout push qui la contient, et un
 * livreur non titulaire y recevrait un 403.
 */
export const PUSH_DELIVERY_OFFER = 'delivery_offer';
export const PUSH_DELIVERY_OFFER_TAKEN = 'delivery_offer_taken';

/**
 * Clé de regroupement : une relance remplace la notification précédente de
 * la même course au lieu de s'empiler (Android `collapseKey`/`tag`, iOS
 * `apns-collapse-id`, 64 octets max).
 */
export function offerCollapseKey(deliveryId: string): string {
  return `offer-${deliveryId}`.slice(0, 64);
}

/** Codes d'erreur stables du claim — les apps lisent `code`, pas `message`. */
export const CLAIM_ERROR = {
  ALREADY_TAKEN: 'DELIVERY_ALREADY_TAKEN',
  DRIVER_BUSY: 'DRIVER_BUSY',
  ORDER_NOT_READY: 'ORDER_NOT_READY',
  DISPATCH_CLOSED: 'DISPATCH_CLOSED',
  NOT_ELIGIBLE: 'DRIVER_NOT_ELIGIBLE',
} as const;

export const MANUAL_ASSIGNMENT_DISABLED = 'MANUAL_ASSIGNMENT_DISABLED';

/** Message exact demandé pour le perdant (§2 de la demande). */
export const ALREADY_TAKEN_MESSAGE =
  'Désolé, cette commande vient d’être acceptée par un autre livreur.';

// ─── État de recherche, dérivé des colonnes `Delivery.dispatch*` ────────────

export type DispatchState =
  /** Aucune recherche n'a jamais été ouverte sur cette course. */
  | 'NONE'
  /** Recherche ouverte : des livreurs peuvent l'accepter. */
  | 'SEARCHING'
  /** Un livreur l'a prise (claim). */
  | 'ASSIGNED'
  /** Cinq diffusions sans preneur : la relance est humaine. */
  | 'EXHAUSTED'
  /** Fermée sans preneur pour une autre raison (commande sortie de PRET…). */
  | 'CLOSED';

export interface DispatchColumns {
  dispatchStartedAt: Date | null;
  dispatchEndedAt: Date | null;
  dispatchOutcome: DispatchOutcome | null;
}

export function isDispatchOpen(d: DispatchColumns): boolean {
  return d.dispatchStartedAt !== null && d.dispatchEndedAt === null;
}

export function dispatchStateOf(d: DispatchColumns): DispatchState {
  if (d.dispatchStartedAt === null && d.dispatchOutcome === null) return 'NONE';
  if (isDispatchOpen(d)) return 'SEARCHING';
  if (d.dispatchOutcome === DispatchOutcome.ASSIGNED) return 'ASSIGNED';
  if (d.dispatchOutcome === DispatchOutcome.EXHAUSTED) return 'EXHAUSTED';
  return 'CLOSED';
}

/** Colonnes d'une recherche (ré)ouverte maintenant. */
export function openedDispatchData(now: Date) {
  return {
    dispatchStartedAt: now,
    dispatchDueAt: now,
    dispatchEndedAt: null,
    dispatchOutcome: null,
    dispatchEndReason: null,
    dispatchRound: 0,
    dispatchNotifiedCount: 0,
  } satisfies Prisma.DeliveryUpdateManyMutationInput;
}

/** Colonnes d'une recherche close maintenant. */
export function closedDispatchData(
  now: Date,
  outcome: DispatchOutcome,
  reason: DispatchEndReason | null = null,
) {
  return {
    dispatchEndedAt: now,
    dispatchOutcome: outcome,
    // CHECK `Delivery_dispatch_consistent` : raison seulement si EXHAUSTED.
    dispatchEndReason: outcome === DispatchOutcome.EXHAUSTED ? reason : null,
  } satisfies Prisma.DeliveryUpdateManyMutationInput;
}

/** Filtre Prisma « recherche ouverte et course encore à prendre ». */
export const CLAIMABLE_DELIVERY_WHERE = {
  status: DeliveryStatus.EN_ATTENTE,
  delivererId: null,
  dispatchStartedAt: { not: null },
  dispatchEndedAt: null,
} satisfies Prisma.DeliveryWhereInput;

// ─── Lectures et écritures en transaction ───────────────────────────────────

/**
 * L'interrupteur, lu **en base** dans la transaction appelante.
 *
 * Jamais le cache de `PlatformSettingsService` (60 s par processus) : deux
 * instances ne doivent pas décider différemment au même instant, l'une
 * ouvrant une recherche pendant que l'autre accepte une assignation manuelle.
 * Une lecture par clé primaire, sans verrou (Prisma ne met rien en cache).
 * Ligne absente = valeur par défaut de la colonne (`false`).
 */
export async function readDispatchEnabled(
  db: Prisma.TransactionClient,
): Promise<boolean> {
  const row = await db.platformSettings.findUnique({
    where: { id: 'singleton' },
    select: { dispatchEnabled: true },
  });
  return row?.dispatchEnabled === true;
}

/**
 * Ferme toute recherche encore ouverte sur la course d'une commande.
 *
 * Appelée par `OrderTransitionService` dans la transaction de toute sortie de
 * `PRET` (annulation, échec, remise) : une commande qui n'est plus prête ne
 * peut plus être proposée, et cette fermeture vit ou meurt avec la
 * transition. Ordre des verrous respecté : la ligne `Order` (R1) est déjà
 * écrite par la transition, `Delivery` (R2) vient après.
 *
 * Le claim n'en dépend pas pour son intégrité — il relit `Order.status` sous
 * `FOR SHARE` — mais la supervision et le cron, eux, lisent ces colonnes.
 */
export async function closeOpenDispatchForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  now: Date = new Date(),
): Promise<number> {
  const closed = await tx.delivery.updateMany({
    where: { orderId, dispatchStartedAt: { not: null }, dispatchEndedAt: null },
    data: closedDispatchData(now, DispatchOutcome.ORDER_CLOSED),
  });
  return closed.count;
}
