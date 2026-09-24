import {
  CLAIM_WINDOW_HOURS,
  composeRefund,
  defaultBearer,
  isClaimWindowOpen,
  PriorRefund,
  RefundableOrder,
  RefundCompositionError,
  refundConflictsWithPayout,
} from './refund-lines.policy';

/**
 * Remboursements partiels (F3-06) — R-06.2, R-06.3, R-06.4, R-06.5, D4.
 * Les montants attendus sont écrits à la main.
 */
const ORDER: RefundableOrder = {
  // 2 × 1 500 (alloco) + 1 × 2 000 (poulet) + 0 (boisson du menu)
  // + 1 000 livraison + 750 service = 6 750 payés.
  paidXaf: 6750,
  deliveryFee: 1000,
  serviceFee: 750,
  items: [
    { id: 'alloco', label: 'Alloco', quantite: 2, unitPriceXaf: 1500 },
    { id: 'poulet', label: 'Poulet DG', quantite: 1, unitPriceXaf: 2000 },
    { id: 'jus', label: 'Menu · Jus', quantite: 1, unitPriceXaf: 0 },
  ],
};

const fails = (fn: () => unknown, code: RefundCompositionError['code']) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RefundCompositionError);
    expect((e as RefundCompositionError).code).toBe(code);
    return;
  }
  throw new Error(`attendu : refus ${code}`);
};

describe('composeRefund', () => {
  it('article : prix figé × quantité, jamais un montant fourni', () => {
    const r = composeRefund(
      ORDER,
      [],
      [{ kind: 'ITEM', orderItemId: 'alloco', quantity: 1, amountXaf: 99_999 }],
    );
    expect(r.totalXaf).toBe(1500);
    expect(r.lines).toEqual([
      {
        kind: 'ITEM',
        orderItemId: 'alloco',
        quantity: 1,
        amountXaf: 1500,
        label: '1 × Alloco',
      },
    ]);
    expect(r.remainingAfterXaf).toBe(5250);
  });

  it('frais sans montant : tout le reliquat', () => {
    const r = composeRefund(ORDER, [], [{ kind: 'DELIVERY_FEE' }]);
    expect(r.totalXaf).toBe(1000);
  });

  it('sur-remboursement d’un article déjà remboursé : refusé', () => {
    const prior: PriorRefund[] = [
      {
        amount: 3000,
        lines: [
          { kind: 'ITEM', orderItemId: 'alloco', quantity: 2, amountXaf: 3000 },
        ],
      },
    ];
    fails(
      () =>
        composeRefund(ORDER, prior, [
          { kind: 'ITEM', orderItemId: 'alloco', quantity: 1 },
        ]),
      'REFUND_ITEM_QUANTITY',
    );
    // Le reliquat de l'article est bien suivi : 1 sur 2, puis 1 autre, puis rien.
    const half: PriorRefund[] = [
      {
        amount: 1500,
        lines: [
          { kind: 'ITEM', orderItemId: 'alloco', quantity: 1, amountXaf: 1500 },
        ],
      },
    ];
    expect(
      composeRefund(ORDER, half, [
        { kind: 'ITEM', orderItemId: 'alloco', quantity: 1 },
      ]).totalXaf,
    ).toBe(1500);
  });

  it('frais de livraison déjà remboursés en partie : le reste au plus', () => {
    const prior: PriorRefund[] = [
      {
        amount: 600,
        lines: [
          {
            kind: 'DELIVERY_FEE',
            orderItemId: null,
            quantity: null,
            amountXaf: 600,
          },
        ],
      },
    ];
    fails(
      () =>
        composeRefund(ORDER, prior, [{ kind: 'DELIVERY_FEE', amountXaf: 500 }]),
      'REFUND_FEE_EXCEEDED',
    );
    expect(
      composeRefund(ORDER, prior, [{ kind: 'DELIVERY_FEE' }]).totalXaf,
    ).toBe(400);
  });

  it('R-06.2 — somme dépassée : refusée, même en gestes', () => {
    fails(
      () => composeRefund(ORDER, [], [{ kind: 'GOODWILL', amountXaf: 6751 }]),
      'REFUND_EXCEEDS_TOTAL',
    );
    // Un remboursement total historique (sans lignes) compte dans la somme.
    fails(
      () =>
        composeRefund(
          ORDER,
          [{ amount: 6000, lines: [] }],
          [{ kind: 'ITEM', orderItemId: 'alloco', quantity: 1 }],
        ),
      'REFUND_EXCEEDS_TOTAL',
    );
  });

  it('article compris dans un menu (prix nul) : refusé, rembourser 0 ne rembourse rien', () => {
    fails(
      () =>
        composeRefund(
          ORDER,
          [],
          [{ kind: 'ITEM', orderItemId: 'jus', quantity: 1 }],
        ),
      'REFUND_ITEM_FREE',
    );
  });

  it('article d’une autre commande, doublon, quantité nulle : refusés', () => {
    fails(
      () =>
        composeRefund(
          ORDER,
          [],
          [{ kind: 'ITEM', orderItemId: 'autre', quantity: 1 }],
        ),
      'REFUND_ITEM_UNKNOWN',
    );
    fails(
      () =>
        composeRefund(
          ORDER,
          [],
          [
            { kind: 'ITEM', orderItemId: 'alloco', quantity: 1 },
            { kind: 'ITEM', orderItemId: 'alloco', quantity: 1 },
          ],
        ),
      'REFUND_ITEM_DUPLICATE',
    );
    fails(
      () =>
        composeRefund(
          ORDER,
          [],
          [{ kind: 'ITEM', orderItemId: 'alloco', quantity: 0 }],
        ),
      'REFUND_ITEM_QUANTITY',
    );
  });

  it('liste vide : refusée à l’écriture, acceptée pour l’aperçu', () => {
    fails(() => composeRefund(ORDER, [], []), 'REFUND_EMPTY');
    const r = composeRefund(ORDER, [], [], { allowEmpty: true });
    expect(r.totalXaf).toBe(0);
    expect(r.refundable).toMatchObject({
      paidXaf: 6750,
      remainingXaf: 6750,
      deliveryFeeRemainingXaf: 1000,
      serviceFeeRemainingXaf: 750,
    });
  });
});

describe('defaultBearer (R-06.4)', () => {
  it.each([
    ['MISSING_ITEM', null, 'VENDOR'],
    ['WRONG_ITEM', null, 'VENDOR'],
    ['DAMAGED', null, 'VENDOR'],
    ['LATE', null, 'PLATFORM'],
    ['GOODWILL', null, 'PLATFORM'],
    ['OTHER', null, 'PLATFORM'],
    ['DELIVERY_FAILED', 'DRIVER', 'DRIVER'],
    ['DELIVERY_FAILED', 'VENDOR', 'VENDOR'],
    ['DELIVERY_FAILED', 'PLATFORM', 'PLATFORM'],
  ] as const)('%s (%s) → %s', (reason, liability, expected) => {
    expect(defaultBearer(reason, liability)).toBe(expected);
  });
});

describe('refundConflictsWithPayout (R-06.5)', () => {
  it.each([
    ['VENDOR', 'MISSING_ITEM', true],
    ['PLATFORM', 'GOODWILL', false],
    ['PLATFORM', 'DELIVERY_FAILED', false],
    ['DRIVER', 'DELIVERY_FAILED', false],
    ['PLATFORM', 'ORDER_CANCELLED', true],
    ['PLATFORM', 'VENDOR_REJECTED', true],
    ['PLATFORM', 'VENDOR_TIMEOUT', true],
  ] as const)('%s / %s → %s', (bearer, reasonCode, expected) => {
    expect(refundConflictsWithPayout({ bearer, reasonCode })).toBe(expected);
  });
});

describe('fenêtre de réclamation (D4 = 24 h)', () => {
  const delivered = new Date('2026-09-25T10:00:00.000Z');
  it('24 h pile : encore ouverte ; une minute de plus : close', () => {
    expect(CLAIM_WINDOW_HOURS).toBe(24);
    expect(
      isClaimWindowOpen(delivered, new Date('2026-09-26T10:00:00.000Z')),
    ).toBe(true);
    expect(
      isClaimWindowOpen(delivered, new Date('2026-09-26T10:01:00.000Z')),
    ).toBe(false);
  });
});
