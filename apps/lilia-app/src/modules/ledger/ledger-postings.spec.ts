import {
  AcquisitionOrder,
  LedgerPostingError,
  Posting,
  acquisitionPosting,
  collectionPosting,
  driverCostPosting,
  driverSettlementPosting,
  payoutPosting,
  pspFeePosting,
  refundPosting,
  reversalPosting,
  vendorAdjustmentPosting,
} from './ledger-postings';

/**
 * Lot 2 — l'équilibre de chaque gabarit est PROUVÉ ici, cas par cas, avant
 * toute écriture en base. Les montants sont écrits à la main : un test qui
 * recalculerait ses attentes avec les formules du code ne prouverait rien.
 *
 * `balances()` additionne les lignes par compte (et sous-compte) : c'est ce
 * que le grand livre donnera en base. Un scénario de bout en bout se lit donc
 * comme un relevé.
 */
const AT = new Date('2026-10-30T10:00:00Z');

function balances(postings: Posting[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of postings) {
    for (const l of p.lines) {
      const key = l.subjectId ? `${l.account}:${l.subjectId}` : l.account;
      out[key] = (out[key] ?? 0) + l.amountXaf;
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== 0));
}

const sum = (p: Posting) => p.lines.reduce((s, l) => s + l.amountXaf, 0);

/**
 * Commande type, en livraison : 3 000 de plats, 1 000 de livraison, 15 % de
 * frais (450), code promo 200, 0 % de commission.
 * total = 3 000 + 1 000 + 450 − 200 = 4 250.
 */
const ORDER: AcquisitionOrder = {
  id: 'o1',
  restaurantId: 'v1',
  subTotal: 3000,
  deliveryFee: 1000,
  serviceFee: 450,
  total: 4250,
  discountAmount: 200,
  vendorFundedDiscountXaf: 0,
  vendorDeliverySubsidyXaf: 0,
  commissionPercent: 0,
  deliveredAt: AT,
};

const pay = (amount: number, orderId = 'o1', id = 'p1') =>
  collectionPosting({
    payment: {
      id,
      orderId,
      provider: 'PAWAPAY',
      amount,
      completedAt: AT,
      providerTransactionId: 'dep-1',
    },
    origin: 'WEBHOOK',
  });

const payout = (amount: number, status = 'SUCCESS') =>
  payoutPosting({
    payout: {
      id: 'po1',
      restaurantId: 'v1',
      amount,
      provider: 'PAWAPAY',
      status,
      completedAt: AT,
      providerTransactionId: 'tx-po',
      providerPayoutId: 'payout-1',
    },
    origin: 'RECONCILIATION',
  });

const refund = (over: {
  amount: number;
  bearer: 'VENDOR' | 'PLATFORM' | 'DRIVER';
  closureMethod: string | null;
  acquired: boolean;
  delivererId?: string | null;
}) =>
  refundPosting({
    refund: {
      id: 'r1',
      orderId: 'o1',
      amount: over.amount,
      bearer: over.bearer,
      closureMethod: over.closureMethod,
      provider: over.closureMethod === 'PROVIDER' ? 'PAWAPAY' : null,
      processedAt: AT,
      providerTransactionId: over.closureMethod === 'PROVIDER' ? 'tx-r1' : null,
      externalReference:
        over.closureMethod && over.closureMethod !== 'PROVIDER'
          ? 'MP-123'
          : null,
    },
    acquired: over.acquired,
    restaurantId: 'v1',
    delivererId: over.delivererId ?? null,
  });

describe('Grand livre — gabarits équilibrés (9 scénarios de la mission)', () => {
  it('1. livraison livrée puis versée : vendeur soldé, transit à zéro, revenus lisibles', () => {
    const postings = [pay(4250), acquisitionPosting(ORDER), payout(3000)];
    postings.forEach((p) => expect(sum(p)).toBe(0));

    expect(balances(postings)).toEqual({
      // Ce qui reste chez pawaPay : encaissé 4 250, versé 3 000.
      'psp:PAWAPAY': 1250,
      // La promo est une charge de Lilia, jamais du vendeur.
      'expense:platform_discount': 200,
      'revenue:service_fee': -450,
      'revenue:delivery': -1000,
      // clearing:order:o1 et vendor_payable:v1 sont à zéro : absents.
    });
  });

  it('1 bis. commission non nulle, offre vendeur et subvention de livraison', () => {
    // 10 % de commission, offre vendeur 300, le vendeur offre 400 de livraison :
    // le client paie 600 de livraison. total = 3 000 + 600 + 450 − 300 = 3 750.
    const o: AcquisitionOrder = {
      ...ORDER,
      deliveryFee: 600,
      total: 3750,
      discountAmount: 300,
      vendorFundedDiscountXaf: 300,
      vendorDeliverySubsidyXaf: 400,
      commissionPercent: 10,
    };
    const acq = acquisitionPosting(o);
    expect(sum(acq)).toBe(0);
    const b = balances([acq]);
    // net vendeur = 3 000 − 300 (commission) − 400 (subvention) − 300 (offre)
    expect(b['vendor_payable:v1']).toBe(-2000);
    expect(b['revenue:commission']).toBe(-300);
    // La livraison rapporte 1 000 : 600 du client + 400 du vendeur.
    expect(b['revenue:delivery']).toBe(-1000);
    // L'offre est financée par le vendeur : aucune charge pour Lilia.
    expect(b['expense:platform_discount']).toBeUndefined();
  });

  it('2. retrait au comptoir : pas de livraison, pas de livreur', () => {
    const o = { ...ORDER, deliveryFee: 0, total: 3250 };
    const postings = [pay(3250), acquisitionPosting(o)];
    postings.forEach((p) => expect(sum(p)).toBe(0));
    expect(balances(postings)).toEqual({
      'psp:PAWAPAY': 3250,
      'expense:platform_discount': 200,
      'vendor_payable:v1': -3000,
      'revenue:service_fee': -450,
    });
  });

  it('3. annulation avant acquisition : tout est rendu, rien n’est acquis', () => {
    const r = refund({
      amount: 4250,
      bearer: 'PLATFORM',
      closureMethod: 'PROVIDER',
      acquired: false,
    });
    expect(sum(r)).toBe(0);
    // Encaissé puis rendu : aucun solde nulle part.
    expect(balances([pay(4250), r])).toEqual({});
  });

  it('4. remboursement à la charge de la plateforme, après livraison', () => {
    const r = refund({
      amount: 800,
      bearer: 'PLATFORM',
      closureMethod: 'MOBILE_MONEY_MANUAL',
      acquired: true,
    });
    expect(sum(r)).toBe(0);
    expect(r.origin).toBe('ADMIN');
    expect(r.evidenceRef).toBe('MP-123');
    expect(balances([r])).toEqual({
      'expense:refund_platform': 800,
      // Déclaré hors prestataire : sorti de `cash:manual`, pas de pawaPay.
      'cash:manual': -800,
    });
  });

  it('5. remboursement à la charge du vendeur : retenu sur son versement', () => {
    const r = refund({
      amount: 1000,
      bearer: 'VENDOR',
      closureMethod: 'PROVIDER',
      acquired: true,
    });
    // Le versement suivant retient le remboursement : 3 000 − 1 000.
    const postings = [pay(4250), acquisitionPosting(ORDER), r, payout(2000)];
    postings.forEach((p) => expect(sum(p)).toBe(0));
    const b = balances(postings);
    expect(b['vendor_payable:v1']).toBeUndefined(); // soldé
    expect(b['psp:PAWAPAY']).toBe(4250 - 1000 - 2000);
  });

  it('5 bis. remboursement vendeur APRÈS versement : la dette apparaît', () => {
    const r = refund({
      amount: 500,
      bearer: 'VENDOR',
      closureMethod: 'PROVIDER',
      acquired: true,
    });
    const b = balances([pay(4250), acquisitionPosting(ORDER), payout(3000), r]);
    // Solde vendeur POSITIF = le vendeur doit 500 à Lilia (dette F3-07).
    expect(b['vendor_payable:v1']).toBe(500);
  });

  it('6. versement abouti : seul SUCCESS déplace de l’argent', () => {
    expect(sum(payout(3000))).toBe(0);
  });

  it.each(['PENDING', 'FAILED', 'CANCELLED'])(
    '7. versement %s (échec ou issue inconnue) : aucune écriture',
    (status) => {
      expect(() => payout(3000, status)).toThrow(LedgerPostingError);
    },
  );

  it('8. coût puis règlement d’un livreur', () => {
    const cost = driverCostPosting({
      id: 'd1',
      delivererId: 'drv1',
      driverPayXaf: 650,
      deliveredAt: AT,
    });
    const settle = driverSettlementPosting({
      id: 's1',
      driverId: 'drv1',
      amountXaf: 650,
      paidAt: AT,
      reference: 'MOMO-77',
      method: 'MOBILE_MONEY',
    });
    [cost, settle].forEach((p) => expect(sum(p)).toBe(0));
    expect(balances([cost])['driver_payable:drv1']).toBe(-650); // dû au livreur
    expect(balances([cost, settle])).toEqual({
      'expense:driver_cost': 650,
      'cash:manual': -650,
    });
  });

  it('9. transaction pawaPay non rapprochée : encaissée, jamais acquise ni rendue', () => {
    // Paiement confirmé sur une commande annulée (« paiement orphelin ») :
    // l'argent reste en transit sur la commande. C'est ce résidu que le
    // rapprochement signale (CLEARING_RESIDUAL) — rien n'est inventé.
    expect(balances([pay(4250, 'o-orpheline', 'p-orph')])).toEqual({
      'psp:PAWAPAY': 4250,
      'clearing:order:o-orpheline': -4250,
    });
  });

  it('remboursement historique sans preuve : sorti du compte d’attente, origine inconnue', () => {
    const r = refund({
      amount: 4250,
      bearer: 'PLATFORM',
      closureMethod: null,
      acquired: false,
    });
    expect(r.origin).toBe('UNKNOWN');
    expect(balances([r])['suspense:unmatched']).toBe(-4250);
  });
});

describe('Grand livre — ce qui est refusé plutôt qu’inventé', () => {
  it('total plafonné à 0 (remises > montant) : exception, pas d’écriture', () => {
    const clamped = { ...ORDER, discountAmount: 10_000, total: 0 };
    expect(() => acquisitionPosting(clamped)).toThrow(LedgerPostingError);
  });

  it('frais : écrits seulement quand ils sont fournis, et équilibrés', () => {
    const fee = pspFeePosting({
      source: 'Payment',
      id: 'p1',
      provider: 'PAWAPAY',
      feeXaf: 85,
      at: AT,
    });
    expect(sum(fee)).toBe(0);
    expect(balances([fee])).toEqual({
      'expense:psp_fee': 85,
      'psp:PAWAPAY': -85,
    });
  });

  it('montant nul : aucune transaction vide', () => {
    expect(() => pay(0)).toThrow(LedgerPostingError);
  });

  it('montant non entier : refusé', () => {
    expect(() => pay(10.5)).toThrow(/entier/);
  });

  it('remboursement livreur sans livreur : exception', () => {
    expect(() =>
      refund({
        amount: 100,
        bearer: 'DRIVER',
        closureMethod: 'CASH',
        acquired: true,
      }),
    ).toThrow(LedgerPostingError);
  });
});

describe('Grand livre — corrections', () => {
  it('ajustement vendeur : motivé, équilibré, dans le bon sens', () => {
    const adj = vendorAdjustmentPosting({
      id: 'vb1',
      restaurantId: 'v1',
      amountXaf: 300, // Lilia doit 300 de plus au vendeur
      createdAt: AT,
      note: 'erreur de saisie',
    });
    expect(balances([adj])).toEqual({
      'expense:vendor_adjustment': 300,
      'vendor_payable:v1': -300,
    });
  });

  it('contre-passation : annule exactement, liée à l’originale', () => {
    const original = pay(4250);
    const reversal = reversalPosting({
      original: {
        id: 'tx1',
        sourceEventKey: original.sourceEventKey,
        lines: original.lines,
      },
      reason: 'paiement saisi deux fois',
      at: AT,
      origin: 'ADMIN',
    });
    expect(reversal.sourceEventKey).toBe('reversal:payment:p1:success');
    expect(balances([original, reversal])).toEqual({});
  });

  it('clés d’idempotence stables : un fait = une clé', () => {
    expect(pay(4250).sourceEventKey).toBe('payment:p1:success');
    expect(acquisitionPosting(ORDER).sourceEventKey).toBe('order:o1:acquired');
    expect(payout(3000).sourceEventKey).toBe('payout:po1:success');
  });
});
