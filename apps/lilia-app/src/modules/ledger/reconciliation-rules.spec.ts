import {
  blockScopeOf,
  compareProviderRows,
  compareWalletBalance,
  LiliaOperation,
  ProviderRow,
} from './reconciliation-rules';

const row = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  externalId: 'dep-1',
  kind: 'DEPOSIT',
  status: 'COMPLETED',
  amountXaf: 4250,
  currency: 'XAF',
  ...over,
});

const op = (over: Partial<LiliaOperation> = {}): LiliaOperation => ({
  externalId: 'dep-1',
  kind: 'DEPOSIT',
  entity: 'Payment',
  entityId: 'p-1',
  status: 'SUCCESS',
  amountXaf: 4250,
  currency: 'XAF',
  feeXaf: null,
  restaurantId: 'v-1',
  orderId: 'o-1',
  concludedInPeriod: true,
  ...over,
});

const types = (f: { type: string }[]) => f.map((x) => x.type).sort();

describe('compareProviderRows', () => {
  it('concordance parfaite : aucun écart', () => {
    expect(compareProviderRows([row()], [op()])).toEqual([]);
  });

  it('encaissement réussi inconnu de Lilia → PROVIDER_ONLY, bloquant global', () => {
    const f = compareProviderRows([row({ externalId: 'dep-x' })], []);
    expect(types(f)).toEqual(['PROVIDER_ONLY']);
    expect(f[0].itemKey).toBe('PROVIDER_ONLY:DEPOSIT:dep-x');
    expect(blockScopeOf('PROVIDER_ONLY')).toBe('GLOBAL');
  });

  it('tentative échouée inconnue de Lilia : rien (aucun argent déplacé)', () => {
    expect(
      compareProviderRows([row({ externalId: 'dep-x', status: 'FAILED' })], []),
    ).toEqual([]);
  });

  it('SUCCESS chez Lilia, absent de l’export → LILIA_ONLY rattaché au vendeur', () => {
    const f = compareProviderRows([], [op()]);
    expect(types(f)).toEqual(['LILIA_ONLY']);
    expect(f[0]).toMatchObject({ restaurantId: 'v-1', paymentId: 'p-1' });
  });

  it('hors période : pas de LILIA_ONLY', () => {
    expect(compareProviderRows([], [op({ concludedInPeriod: false })])).toEqual(
      [],
    );
  });

  it('montant différent → AMOUNT_MISMATCH avec attendu et constaté', () => {
    const f = compareProviderRows([row({ amountXaf: 4000 })], [op()]);
    expect(types(f)).toEqual(['AMOUNT_MISMATCH']);
    expect(f[0]).toMatchObject({ expectedXaf: 4250, actualXaf: 4000 });
  });

  it('devise étrangère → CURRENCY_MISMATCH', () => {
    const f = compareProviderRows([row({ currency: 'EUR' })], [op()]);
    expect(types(f)).toContain('CURRENCY_MISMATCH');
  });

  it('COMPLETED chez le prestataire, FAILED chez Lilia → STATUS_CONFLICT', () => {
    const f = compareProviderRows([row()], [op({ status: 'FAILED' })]);
    expect(types(f)).toEqual(['STATUS_CONFLICT']);
  });

  it('FAILED chez le prestataire, SUCCESS chez Lilia → STATUS_CONFLICT', () => {
    const f = compareProviderRows([row({ status: 'FAILED' })], [op()]);
    expect(types(f)).toEqual(['STATUS_CONFLICT']);
  });

  it('identifiant deux fois dans l’export → DUPLICATE_PROVIDER_ROW', () => {
    const f = compareProviderRows([row(), row()], [op()]);
    expect(types(f)).toEqual(['DUPLICATE_PROVIDER_ROW']);
  });

  it('frais donnés par l’export, inconnus de Lilia → FEE_UNKNOWN non bloquant', () => {
    const f = compareProviderRows([row({ feeXaf: 85 })], [op()]);
    expect(types(f)).toEqual(['FEE_UNKNOWN']);
    expect(blockScopeOf('FEE_UNKNOWN')).toBe('NONE');
  });

  it('frais différents → FEE_MISMATCH', () => {
    const f = compareProviderRows([row({ feeXaf: 85 })], [op({ feeXaf: 80 })]);
    expect(types(f)).toEqual(['FEE_MISMATCH']);
  });

  it('même identifiant, deux sens (encaissement / versement) : pas de collision', () => {
    const f = compareProviderRows(
      [row(), row({ kind: 'PAYOUT', amountXaf: 3000 })],
      [
        op(),
        op({
          kind: 'PAYOUT',
          entity: 'RestaurantPayout',
          entityId: 'po-1',
          amountXaf: 3000,
        }),
      ],
    );
    expect(f).toEqual([]);
  });

  it('clé d’écart stable : rejouer la même comparaison donne les mêmes clés', () => {
    const a = compareProviderRows([row({ amountXaf: 1 })], [op()]);
    const b = compareProviderRows([row({ amountXaf: 1 })], [op()]);
    expect(a.map((x) => x.itemKey)).toEqual(b.map((x) => x.itemKey));
  });
});

describe('compareWalletBalance', () => {
  it('égal ou non fourni : rien', () => {
    expect(compareWalletBalance(1000, 1000)).toEqual([]);
    expect(compareWalletBalance(null, 1000)).toEqual([]);
  });

  it('différent → WALLET_BALANCE_MISMATCH, bloquant global', () => {
    const f = compareWalletBalance(900, 1000);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      type: 'WALLET_BALANCE_MISMATCH',
      expectedXaf: 1000,
      actualXaf: 900,
    });
    expect(blockScopeOf(f[0].type)).toBe('GLOBAL');
  });
});

describe('blockScopeOf', () => {
  it('type inconnu : ne bloque pas', () => {
    expect(blockScopeOf('INCONNU')).toBe('NONE');
  });
});
