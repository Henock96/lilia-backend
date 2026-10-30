import { computePayoutBreakdown } from '../payments/money.util';
import {
  LedgerAccount,
  LedgerKind,
  LedgerOrigin,
  LedgerSubjectType,
  pspAccount,
} from './ledger-accounts';

/**
 * Gabarits d'écriture du grand livre — fonctions PURES (lot 2, 30/10/2026).
 *
 * Chaque gabarit traduit UN fait durable déjà en base (paiement abouti,
 * commande livrée, remboursement conclu…) en une transaction équilibrée. Il ne
 * lit rien, n'écrit rien : c'est ce qui permet de prouver l'équilibre de chaque
 * cas par un test, avant toute écriture.
 *
 * ## Formules (vérifiées le 30/10/2026 contre le code)
 *
 * `OrderCheckoutService.createOrderFromCart` :
 *   total = max(0, subTotal + deliveryFee + serviceFee − discountAmount)
 *   discountAmount = promo + fidélité + offre vendeur (vendorFundedDiscountXaf)
 *
 * `computePayoutBreakdown` (`money.util.ts`) :
 *   net vendeur = subTotal − commission − subvention livraison − offre vendeur
 *   (la promo et la fidélité sont des remises de Lilia : jamais retenues au vendeur)
 *
 * À l'acquisition (commande livrée), l'équilibre est algébrique :
 *   débit  = total + remise plateforme
 *          = subTotal + deliveryFee + serviceFee − offre
 *   crédit = net vendeur + commission + serviceFee + (deliveryFee + subvention)
 *          = subTotal + serviceFee + deliveryFee − offre
 * Un total plafonné à 0 (remises > montant) rompt l'égalité : le gabarit
 * REFUSE au lieu d'inventer un montant (`LedgerPostingError`).
 */

export interface PostingLine {
  account: LedgerAccount;
  subjectType?: LedgerSubjectType;
  subjectId?: string;
  /** XAF entiers, débit > 0, crédit < 0. */
  amountXaf: number;
}

export interface Posting {
  /** Clé d'idempotence : un fait source = une transaction, jamais deux. */
  sourceEventKey: string;
  kind: LedgerKind;
  sourceType: string;
  sourceId: string;
  occurredAt: Date;
  origin: LedgerOrigin;
  /** Référence opposable (transaction prestataire, reçu…), quand elle existe. */
  evidenceRef?: string | null;
  note?: string | null;
  lines: PostingLine[];
}

/** Le fait ne peut pas être écrit sans inventer : il part en exception. */
export class LedgerPostingError extends Error {
  constructor(
    readonly sourceEventKey: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Retire les lignes nulles, vérifie entiers et équilibre. */
export function finalizePosting(posting: Posting): Posting {
  const lines = posting.lines.filter((l) => l.amountXaf !== 0);
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amountXaf)) {
      throw new LedgerPostingError(
        posting.sourceEventKey,
        'NON_INTEGER_AMOUNT',
        `Montant non entier sur ${l.account} : ${l.amountXaf}`,
      );
    }
  }
  const sum = lines.reduce((s, l) => s + l.amountXaf, 0);
  if (sum !== 0) {
    throw new LedgerPostingError(
      posting.sourceEventKey,
      'UNBALANCED',
      `Transaction déséquilibrée (${sum} XAF) — rien n'est écrit`,
    );
  }
  if (lines.length < 2) {
    throw new LedgerPostingError(
      posting.sourceEventKey,
      'EMPTY',
      'Transaction sans mouvement (montants nuls)',
    );
  }
  return { ...posting, lines };
}

const order = (id: string) => ({
  subjectType: 'ORDER' as const,
  subjectId: id,
});
const vendor = (id: string) => ({
  subjectType: 'VENDOR' as const,
  subjectId: id,
});
const driver = (id: string) => ({
  subjectType: 'DRIVER' as const,
  subjectId: id,
});

// ─── Encaissement ─────────────────────────────────────────────────────────

export function collectionPosting(input: {
  payment: {
    id: string;
    orderId: string;
    provider: string;
    amount: number;
    completedAt: Date;
    providerTransactionId: string | null;
  };
  origin: LedgerOrigin;
}): Posting {
  const p = input.payment;
  return finalizePosting({
    sourceEventKey: `payment:${p.id}:success`,
    kind: 'COLLECTION',
    sourceType: 'Payment',
    sourceId: p.id,
    occurredAt: p.completedAt,
    origin: input.origin,
    evidenceRef: p.providerTransactionId,
    lines: [
      { account: pspAccount(p.provider), amountXaf: p.amount },
      { account: 'clearing:order', ...order(p.orderId), amountXaf: -p.amount },
    ],
  });
}

// ─── Acquisition (commande livrée) ──────────────────────────────────────────

export interface AcquisitionOrder {
  id: string;
  restaurantId: string;
  subTotal: number;
  deliveryFee: number;
  serviceFee: number;
  total: number;
  discountAmount: number;
  vendorFundedDiscountXaf: number;
  vendorDeliverySubsidyXaf: number;
  commissionPercent: number;
  deliveredAt: Date;
}

export function acquisitionPosting(o: AcquisitionOrder): Posting {
  const key = `order:${o.id}:acquired`;
  const expectedTotal =
    o.subTotal + o.deliveryFee + o.serviceFee - o.discountAmount;
  if (expectedTotal !== o.total) {
    throw new LedgerPostingError(
      key,
      'TOTAL_INCONSISTENT',
      `Total ${o.total} ≠ sous-total + livraison + frais − remises (${expectedTotal}) : ` +
        'total plafonné ou snapshot incohérent, à arbitrer.',
    );
  }
  const b = computePayoutBreakdown({
    subTotalXaf: o.subTotal,
    commissionPercent: o.commissionPercent,
    deliverySubsidyXaf: o.vendorDeliverySubsidyXaf,
    vendorOfferDiscountXaf: o.vendorFundedDiscountXaf,
  });
  // Le décompte borne subvention et offre au net vendeur ; si un bornage a
  // joué, l'équilibre ci-dessus ne tient plus : on le dit au lieu de forcer.
  if (
    b.deliverySubsidyAmount !== o.vendorDeliverySubsidyXaf ||
    b.vendorOfferAmount !== o.vendorFundedDiscountXaf
  ) {
    throw new LedgerPostingError(
      key,
      'PAYOUT_CAPPED',
      'Subvention ou offre vendeur bornée par le net vendeur : répartition à arbitrer.',
    );
  }
  const platformDiscount = o.discountAmount - o.vendorFundedDiscountXaf;
  return finalizePosting({
    sourceEventKey: key,
    kind: 'ACQUISITION',
    sourceType: 'Order',
    sourceId: o.id,
    occurredAt: o.deliveredAt,
    origin: 'SYSTEM',
    note: `commission ${b.commissionPercent} %`,
    lines: [
      { account: 'clearing:order', ...order(o.id), amountXaf: o.total },
      { account: 'expense:platform_discount', amountXaf: platformDiscount },
      {
        account: 'vendor_payable',
        ...vendor(o.restaurantId),
        amountXaf: -b.payoutAmount,
      },
      { account: 'revenue:commission', amountXaf: -b.commissionAmount },
      { account: 'revenue:service_fee', amountXaf: -o.serviceFee },
      {
        account: 'revenue:delivery',
        amountXaf: -(o.deliveryFee + o.vendorDeliverySubsidyXaf),
      },
    ],
  });
}

// ─── Coût livreur ───────────────────────────────────────────────────────────

export function driverCostPosting(d: {
  id: string;
  delivererId: string;
  driverPayXaf: number;
  deliveredAt: Date;
}): Posting {
  return finalizePosting({
    sourceEventKey: `delivery:${d.id}:driver_cost`,
    kind: 'DRIVER_COST',
    sourceType: 'Delivery',
    sourceId: d.id,
    occurredAt: d.deliveredAt,
    origin: 'SYSTEM',
    lines: [
      { account: 'expense:driver_cost', amountXaf: d.driverPayXaf },
      {
        account: 'driver_payable',
        ...driver(d.delivererId),
        amountXaf: -d.driverPayXaf,
      },
    ],
  });
}

// ─── Remboursement conclu ─────────────────────────────────────────────────

export function refundPosting(input: {
  refund: {
    id: string;
    orderId: string;
    amount: number;
    bearer: 'VENDOR' | 'PLATFORM' | 'DRIVER';
    closureMethod: string | null;
    provider: string | null;
    processedAt: Date;
    providerTransactionId: string | null;
    externalReference: string | null;
  };
  /** La commande a-t-elle déjà été acquise (transaction ACQUISITION écrite) ? */
  acquired: boolean;
  restaurantId: string;
  delivererId: string | null;
}): Posting {
  const r = input.refund;
  const key = `refund:${r.id}:completed`;

  // D'où l'argent est sorti — jamais deviné.
  let funding: LedgerAccount;
  let origin: LedgerOrigin;
  if (r.closureMethod === 'PROVIDER') {
    if (!r.provider) {
      throw new LedgerPostingError(
        key,
        'PROVIDER_MISSING',
        'Remboursement « prestataire » sans prestataire',
      );
    }
    funding = pspAccount(r.provider);
    origin = 'SYSTEM';
  } else if (r.closureMethod) {
    funding = 'cash:manual';
    origin = 'ADMIN';
  } else {
    // Clôture historique sans preuve : on n'affirme pas d'où vient l'argent.
    funding = 'suspense:unmatched';
    origin = 'UNKNOWN';
  }

  // Qui supporte le remboursement.
  let charged: PostingLine;
  if (!input.acquired) {
    // Commande jamais acquise (annulée, expirée, échec) : on rend ce qui a été
    // encaissé et qui attendait sur la commande.
    charged = {
      account: 'clearing:order',
      ...order(r.orderId),
      amountXaf: r.amount,
    };
  } else if (r.bearer === 'VENDOR') {
    charged = {
      account: 'vendor_payable',
      ...vendor(input.restaurantId),
      amountXaf: r.amount,
    };
  } else if (r.bearer === 'DRIVER') {
    if (!input.delivererId) {
      throw new LedgerPostingError(
        key,
        'DRIVER_MISSING',
        'Remboursement à la charge du livreur sans livreur',
      );
    }
    charged = {
      account: 'driver_payable',
      ...driver(input.delivererId),
      amountXaf: r.amount,
    };
  } else {
    charged = { account: 'expense:refund_platform', amountXaf: r.amount };
  }

  return finalizePosting({
    sourceEventKey: key,
    kind: 'REFUND',
    sourceType: 'Refund',
    sourceId: r.id,
    occurredAt: r.processedAt,
    origin,
    evidenceRef: r.providerTransactionId ?? r.externalReference,
    note: r.closureMethod
      ? `clôture ${r.closureMethod}`
      : 'clôture historique non qualifiée',
    lines: [charged, { account: funding, amountXaf: -r.amount }],
  });
}

// ─── Versement vendeur abouti ─────────────────────────────────────────────

export function payoutPosting(input: {
  payout: {
    id: string;
    restaurantId: string;
    amount: number;
    provider: string;
    status: string;
    completedAt: Date;
    providerTransactionId: string | null;
    providerPayoutId: string | null;
  };
  origin: LedgerOrigin;
}): Posting {
  const p = input.payout;
  const key = `payout:${p.id}:success`;
  if (p.status !== 'SUCCESS') {
    // Payé = SUCCESS, rien d'autre (règle 7) : un versement en vol, en échec
    // ou annulé ne déplace pas d'argent dans le grand livre.
    throw new LedgerPostingError(
      key,
      'NOT_SUCCESS',
      `Versement ${p.status} : aucune écriture`,
    );
  }
  return finalizePosting({
    sourceEventKey: key,
    kind: 'PAYOUT',
    sourceType: 'RestaurantPayout',
    sourceId: p.id,
    occurredAt: p.completedAt,
    origin: input.origin,
    evidenceRef: p.providerTransactionId ?? p.providerPayoutId,
    lines: [
      {
        account: 'vendor_payable',
        ...vendor(p.restaurantId),
        amountXaf: p.amount,
      },
      { account: pspAccount(p.provider), amountXaf: -p.amount },
    ],
  });
}

// ─── Frais prestataire CONFIRMÉS ──────────────────────────────────────────

export function pspFeePosting(input: {
  source: 'Payment' | 'RestaurantPayout';
  id: string;
  provider: string;
  feeXaf: number;
  at: Date;
}): Posting {
  return finalizePosting({
    sourceEventKey: `${input.source === 'Payment' ? 'payment' : 'payout'}:${input.id}:fee`,
    kind: 'PSP_FEE',
    sourceType: input.source,
    sourceId: input.id,
    occurredAt: input.at,
    origin: 'SYSTEM',
    lines: [
      { account: 'expense:psp_fee', amountXaf: input.feeXaf },
      { account: pspAccount(input.provider), amountXaf: -input.feeXaf },
    ],
  });
}

// ─── Règlement livreur ──────────────────────────────────────────────────────

export function driverSettlementPosting(s: {
  id: string;
  driverId: string;
  amountXaf: number;
  paidAt: Date;
  reference: string | null;
  method: string;
}): Posting {
  return finalizePosting({
    sourceEventKey: `driver_settlement:${s.id}:paid`,
    kind: 'DRIVER_SETTLEMENT',
    sourceType: 'DriverSettlement',
    sourceId: s.id,
    occurredAt: s.paidAt,
    origin: 'ADMIN',
    evidenceRef: s.reference,
    note: `règlement ${s.method}`,
    lines: [
      {
        account: 'driver_payable',
        ...driver(s.driverId),
        amountXaf: s.amountXaf,
      },
      { account: 'cash:manual', amountXaf: -s.amountXaf },
    ],
  });
}

// ─── Correction manuelle du solde vendeur ─────────────────────────────────

export function vendorAdjustmentPosting(e: {
  id: string;
  restaurantId: string;
  /** Signe de `VendorBalanceEntry` : > 0 = Lilia doit davantage au vendeur. */
  amountXaf: number;
  createdAt: Date;
  note: string | null;
}): Posting {
  return finalizePosting({
    sourceEventKey: `vendor_balance:${e.id}:adjustment`,
    kind: 'VENDOR_ADJUSTMENT',
    sourceType: 'VendorBalanceEntry',
    sourceId: e.id,
    occurredAt: e.createdAt,
    origin: 'ADMIN',
    note: e.note,
    lines: [
      { account: 'expense:vendor_adjustment', amountXaf: e.amountXaf },
      {
        account: 'vendor_payable',
        ...vendor(e.restaurantId),
        amountXaf: -e.amountXaf,
      },
    ],
  });
}

// ─── Contre-passation ─────────────────────────────────────────────────────

/**
 * Corrige une transaction sans la modifier : mêmes lignes, signes inversés,
 * liée à l'originale. Une transaction ne se contre-passe qu'une fois (unicité
 * `reversesTxId` en base).
 */
export function reversalPosting(input: {
  original: { id: string; sourceEventKey: string; lines: PostingLine[] };
  reason: string;
  at: Date;
  origin: LedgerOrigin;
}): Posting {
  return finalizePosting({
    sourceEventKey: `reversal:${input.original.sourceEventKey}`,
    kind: 'REVERSAL',
    sourceType: 'LedgerTransaction',
    sourceId: input.original.id,
    occurredAt: input.at,
    origin: input.origin,
    note: input.reason,
    lines: input.original.lines.map((l) => ({ ...l, amountXaf: -l.amountXaf })),
  });
}
