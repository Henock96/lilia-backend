import {
  FailureLiability,
  RefundBearer,
  RefundLineKind,
  RefundReasonCode,
  RefundStatus,
} from '@prisma/client';

/**
 * Remboursements partiels (F3-06) — règles d'argent, pures.
 *
 * Tout ce qui décide d'un montant vit ici, sans base ni horloge implicite :
 * le composeur de l'administration (aperçu ET écriture) passe par
 * `composeRefund`, jamais par un calcul local. Deux implémentations d'une même
 * règle d'argent divergent, et c'est le client qui le voit sur son MoMo.
 */

/** D4 (24/09/2026) — une réclamation s'ouvre au plus 24 h après la livraison. */
export const CLAIM_WINDOW_HOURS = 24;

/**
 * Motifs des remboursements **totaux automatiques** : au plus un par commande
 * (index `Refund_orderId_auto_uq`). Le composeur ne les propose jamais.
 */
export const AUTO_REFUND_REASON_CODES: RefundReasonCode[] = [
  RefundReasonCode.ORDER_CANCELLED,
  RefundReasonCode.VENDOR_REJECTED,
  RefundReasonCode.VENDOR_TIMEOUT,
  RefundReasonCode.DELIVERY_FAILED,
];

/** Motifs que l'administration peut choisir dans le composeur. */
export const MANUAL_REFUND_REASON_CODES = [
  RefundReasonCode.MISSING_ITEM,
  RefundReasonCode.WRONG_ITEM,
  RefundReasonCode.DAMAGED,
  RefundReasonCode.LATE,
  RefundReasonCode.GOODWILL,
  RefundReasonCode.OTHER,
] as const;
export type ManualRefundReasonCode =
  (typeof MANUAL_REFUND_REASON_CODES)[number];

/** Un remboursement qui compte dans les plafonds : tout sauf `REJECTED`. */
export const COUNTED_REFUND_STATUSES: RefundStatus[] = [
  RefundStatus.PENDING,
  RefundStatus.PROCESSING,
  RefundStatus.COMPLETED,
];

export const IN_FLIGHT_REFUND_STATUSES: RefundStatus[] = [
  RefundStatus.PENDING,
  RefundStatus.PROCESSING,
];

/**
 * Payeur par défaut (R-06.4). L'administration peut le changer : c'est un
 * point de départ, pas une décision.
 *
 *  - article manquant, erroné ou abîmé : le vendeur (c'est sa préparation) ;
 *  - retard, geste commercial, autre : la plateforme ;
 *  - échec de livraison : celui que l'arbitrage F3-05 a désigné.
 */
export function defaultBearer(
  reasonCode: RefundReasonCode,
  failureLiability: FailureLiability | null = null,
): RefundBearer {
  switch (reasonCode) {
    case RefundReasonCode.MISSING_ITEM:
    case RefundReasonCode.WRONG_ITEM:
    case RefundReasonCode.DAMAGED:
      return RefundBearer.VENDOR;
    case RefundReasonCode.DELIVERY_FAILED:
      if (failureLiability === 'VENDOR') return RefundBearer.VENDOR;
      if (failureLiability === 'DRIVER') return RefundBearer.DRIVER;
      return RefundBearer.PLATFORM;
    default:
      return RefundBearer.PLATFORM;
  }
}

/**
 * Le remboursement touche-t-il à ce que le vendeur doit recevoir ?
 *
 * Invariant F-04 reformulé (R-06.5) : tant que le grand livre vendeur (F3-07)
 * n'existe pas, un remboursement ne se croise avec un reversement que s'il est
 * à la charge du vendeur, ou s'il rembourse une commande que le vendeur ne
 * devait pas être payé (annulation, refus, silence). Un geste commercial de la
 * plateforme sur une commande livrée ne lui retire rien.
 */
export function refundConflictsWithPayout(refund: {
  bearer: RefundBearer;
  reasonCode: RefundReasonCode;
}): boolean {
  if (refund.bearer === RefundBearer.VENDOR) return true;
  return (
    refund.reasonCode === RefundReasonCode.ORDER_CANCELLED ||
    refund.reasonCode === RefundReasonCode.VENDOR_REJECTED ||
    refund.reasonCode === RefundReasonCode.VENDOR_TIMEOUT
  );
}

/** Instant de livraison → la réclamation est-elle encore ouverte ? */
export function claimWindowClosesAt(deliveredAt: Date): Date {
  return new Date(deliveredAt.getTime() + CLAIM_WINDOW_HOURS * 3_600_000);
}

export function isClaimWindowOpen(deliveredAt: Date, now: Date): boolean {
  return now.getTime() <= claimWindowClosesAt(deliveredAt).getTime();
}

// ─── Composition ────────────────────────────────────────────────────────────

export interface RefundableOrder {
  /** Plafond absolu : ce que le client a réellement payé. */
  paidXaf: number;
  deliveryFee: number;
  serviceFee: number;
  items: {
    id: string;
    label: string;
    quantite: number;
    /** Prix unitaire figé (`snapshotPrice ?? prix`). */
    unitPriceXaf: number;
  }[];
  /**
   * F3-11 (Q3) — offre boutique appliquée à la commande. Le client n'a payé
   * ses articles que net de l'offre : les lui rembourser au prix brut lui
   * rendrait plus qu'il n'a payé, aux frais du vendeur (payeur par défaut
   * d'un article manquant), qui n'a lui-même touché que le net.
   */
  vendorOffer?: { subTotalXaf: number; discountXaf: number } | null;
}

/**
 * Prix unitaire remboursable d'un article : le prix figé, net de l'offre
 * boutique au prorata du sous-total. Arrondi à l'inférieur — le client ne
 * récupère jamais plus qu'il n'a payé ; l'écart est inférieur à 1 FCFA par
 * article.
 */
export function refundableUnitPriceXaf(
  unitPriceXaf: number,
  vendorOffer: RefundableOrder['vendorOffer'],
): number {
  if (
    !vendorOffer ||
    vendorOffer.discountXaf <= 0 ||
    vendorOffer.subTotalXaf <= 0
  ) {
    return unitPriceXaf;
  }
  const net = vendorOffer.subTotalXaf - vendorOffer.discountXaf;
  return Math.floor((unitPriceXaf * net) / vendorOffer.subTotalXaf);
}

/** Remboursements déjà comptés (hors `REJECTED`), avec leurs lignes. */
export interface PriorRefund {
  amount: number;
  lines: {
    kind: RefundLineKind;
    orderItemId: string | null;
    quantity: number | null;
    amountXaf: number;
  }[];
}

export interface RequestedLine {
  kind: RefundLineKind;
  orderItemId?: string;
  quantity?: number;
  /** Frais ou geste : montant voulu. Absent sur un frais = le reliquat. */
  amountXaf?: number;
}

export interface ComposedLine {
  kind: RefundLineKind;
  orderItemId: string | null;
  quantity: number | null;
  amountXaf: number;
  label: string;
}

export interface RefundableItem {
  orderItemId: string;
  label: string;
  orderedQty: number;
  refundedQty: number;
  unitPriceXaf: number;
}

export interface RefundComposition {
  lines: ComposedLine[];
  totalXaf: number;
  /** Ce qui reste remboursable APRÈS ce remboursement. */
  remainingAfterXaf: number;
  /** État de la commande AVANT ce remboursement — ce que le composeur affiche. */
  refundable: {
    paidXaf: number;
    alreadyRefundedXaf: number;
    remainingXaf: number;
    deliveryFeeRemainingXaf: number;
    serviceFeeRemainingXaf: number;
    items: RefundableItem[];
  };
}

/** Refus du composeur : le message se lit tel quel, le code se traite. */
export class RefundCompositionError extends Error {
  constructor(
    readonly code:
      | 'REFUND_EMPTY'
      | 'REFUND_ITEM_UNKNOWN'
      | 'REFUND_ITEM_DUPLICATE'
      | 'REFUND_ITEM_QUANTITY'
      | 'REFUND_ITEM_FREE'
      | 'REFUND_FEE_EXCEEDED'
      | 'REFUND_AMOUNT_INVALID'
      | 'REFUND_EXCEEDS_TOTAL',
    message: string,
  ) {
    super(message);
  }
}

const fmt = (n: number) => `${n.toLocaleString('fr-FR')} FCFA`;

/**
 * Compose un remboursement à partir de lignes demandées (R-06.2, R-06.3).
 *
 * - `ITEM` : quantité ≤ commandée − déjà remboursée ; montant = prix figé
 *   (net de l'offre boutique, F3-11) × quantité, **jamais** fourni par
 *   l'appelant ;
 * - `DELIVERY_FEE` / `SERVICE_FEE` : au plus le reliquat du frais ; sans
 *   montant, tout le reliquat ;
 * - `GOODWILL` : montant libre, strictement positif ;
 * - Σ (déjà remboursé + ce remboursement) ≤ montant payé.
 *
 * Une liste vide est acceptée pour l'aperçu (`allowEmpty`) : elle rend l'état
 * remboursable de la commande, ce dont le composeur a besoin pour s'afficher.
 */
export function composeRefund(
  order: RefundableOrder,
  prior: PriorRefund[],
  requested: RequestedLine[],
  options: { allowEmpty?: boolean } = {},
): RefundComposition {
  const alreadyRefundedXaf = prior.reduce((s, r) => s + r.amount, 0);
  const priorLines = prior.flatMap((r) => r.lines);

  const refundedQty = new Map<string, number>();
  let deliveryRefunded = 0;
  let serviceRefunded = 0;
  for (const l of priorLines) {
    if (l.kind === RefundLineKind.ITEM && l.orderItemId) {
      refundedQty.set(
        l.orderItemId,
        (refundedQty.get(l.orderItemId) ?? 0) + (l.quantity ?? 0),
      );
    } else if (l.kind === RefundLineKind.DELIVERY_FEE) {
      deliveryRefunded += l.amountXaf;
    } else if (l.kind === RefundLineKind.SERVICE_FEE) {
      serviceRefunded += l.amountXaf;
    }
  }

  const items: RefundableItem[] = order.items.map((it) => ({
    orderItemId: it.id,
    label: it.label,
    orderedQty: it.quantite,
    refundedQty: refundedQty.get(it.id) ?? 0,
    unitPriceXaf: refundableUnitPriceXaf(it.unitPriceXaf, order.vendorOffer),
  }));
  const remainingXaf = Math.max(0, order.paidXaf - alreadyRefundedXaf);
  const refundable = {
    paidXaf: order.paidXaf,
    alreadyRefundedXaf,
    remainingXaf,
    deliveryFeeRemainingXaf: Math.max(0, order.deliveryFee - deliveryRefunded),
    serviceFeeRemainingXaf: Math.max(0, order.serviceFee - serviceRefunded),
    items,
  };

  if (requested.length === 0) {
    if (options.allowEmpty) {
      return {
        lines: [],
        totalXaf: 0,
        remainingAfterXaf: remainingXaf,
        refundable,
      };
    }
    throw new RefundCompositionError(
      'REFUND_EMPTY',
      'Cochez au moins un article, un frais ou un geste commercial.',
    );
  }

  const lines: ComposedLine[] = [];
  const seenItems = new Set<string>();
  const seenFees = new Set<RefundLineKind>();

  for (const req of requested) {
    switch (req.kind) {
      case RefundLineKind.ITEM: {
        const item = items.find((i) => i.orderItemId === req.orderItemId);
        if (!item) {
          throw new RefundCompositionError(
            'REFUND_ITEM_UNKNOWN',
            "Cet article n'appartient pas à la commande.",
          );
        }
        if (seenItems.has(item.orderItemId)) {
          throw new RefundCompositionError(
            'REFUND_ITEM_DUPLICATE',
            `« ${item.label} » figure deux fois : regroupez les quantités.`,
          );
        }
        seenItems.add(item.orderItemId);
        const qty = req.quantity ?? 0;
        const left = item.orderedQty - item.refundedQty;
        if (!Number.isInteger(qty) || qty < 1 || qty > left) {
          throw new RefundCompositionError(
            'REFUND_ITEM_QUANTITY',
            left <= 0
              ? `« ${item.label} » a déjà été entièrement remboursé.`
              : `« ${item.label} » : ${left} au plus (${item.orderedQty} commandé(s), ${item.refundedQty} déjà remboursé(s)).`,
          );
        }
        // Un article compris dans un menu porte un prix nul : c'est la ligne
        // principale du menu qui porte le prix. Rembourser 0 ne rembourse rien.
        if (item.unitPriceXaf <= 0) {
          throw new RefundCompositionError(
            'REFUND_ITEM_FREE',
            `« ${item.label} » est compris dans un menu : remboursez la ligne du menu, ou faites un geste commercial.`,
          );
        }
        lines.push({
          kind: RefundLineKind.ITEM,
          orderItemId: item.orderItemId,
          quantity: qty,
          amountXaf: item.unitPriceXaf * qty,
          label: `${qty} × ${item.label}`,
        });
        break;
      }
      case RefundLineKind.DELIVERY_FEE:
      case RefundLineKind.SERVICE_FEE: {
        if (seenFees.has(req.kind)) {
          throw new RefundCompositionError(
            'REFUND_ITEM_DUPLICATE',
            'Ce frais figure deux fois.',
          );
        }
        seenFees.add(req.kind);
        const isDelivery = req.kind === RefundLineKind.DELIVERY_FEE;
        const left = isDelivery
          ? refundable.deliveryFeeRemainingXaf
          : refundable.serviceFeeRemainingXaf;
        const amount = req.amountXaf ?? left;
        const label = isDelivery ? 'Frais de livraison' : 'Frais de service';
        if (left <= 0) {
          throw new RefundCompositionError(
            'REFUND_FEE_EXCEEDED',
            `${label} : rien à rembourser (déjà remboursés, ou non facturés).`,
          );
        }
        if (!Number.isInteger(amount) || amount < 1 || amount > left) {
          throw new RefundCompositionError(
            'REFUND_FEE_EXCEEDED',
            `${label} : ${fmt(left)} au plus.`,
          );
        }
        lines.push({
          kind: req.kind,
          orderItemId: null,
          quantity: null,
          amountXaf: amount,
          label,
        });
        break;
      }
      case RefundLineKind.GOODWILL: {
        const amount = req.amountXaf ?? 0;
        if (!Number.isInteger(amount) || amount < 1) {
          throw new RefundCompositionError(
            'REFUND_AMOUNT_INVALID',
            'Le geste commercial doit être un montant entier positif.',
          );
        }
        if (lines.some((l) => l.kind === RefundLineKind.GOODWILL)) {
          throw new RefundCompositionError(
            'REFUND_ITEM_DUPLICATE',
            'Un seul geste commercial par remboursement.',
          );
        }
        lines.push({
          kind: RefundLineKind.GOODWILL,
          orderItemId: null,
          quantity: null,
          amountXaf: amount,
          label: 'Geste commercial',
        });
        break;
      }
    }
  }

  const totalXaf = lines.reduce((s, l) => s + l.amountXaf, 0);
  if (totalXaf > remainingXaf) {
    throw new RefundCompositionError(
      'REFUND_EXCEEDS_TOTAL',
      `Ce remboursement (${fmt(totalXaf)}) dépasse ce qui reste remboursable sur la commande (${fmt(remainingXaf)} sur ${fmt(order.paidXaf)} payés).`,
    );
  }

  return {
    lines,
    totalXaf,
    remainingAfterXaf: remainingXaf - totalXaf,
    refundable,
  };
}
