import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { PawaPayProvider } from './pawapay.provider';
import { PawaPayHttpService } from './pawapay-http.service';
import { ProviderUnavailableError } from '../payment-provider.interface';
import {
  formatAmountForPawaPay,
  isValidCongoMsisdn,
  mapPawaPayState,
  parseAmountToXaf,
  sanitizeCustomerMessage,
  toMsisdn,
} from './pawapay.mapper';

/**
 * Provider pawaPay — conformité au contrat documenté et comportement en panne.
 *
 * Les corps de requête sont vérifiés champ par champ : une erreur de nom
 * (`payer` vs `recipient`, `depositId` vs `payoutId`) ne se voit qu'en
 * production, sur de l'argent réel.
 */
describe('PawaPayProvider', () => {
  let provider: PawaPayProvider;

  const http = {
    post: jest.fn(),
    get: jest.fn(),
    isConfigured: true,
    getActiveConfiguration: jest.fn(),
  };

  const config = {
    get: (key: string, fallback?: unknown) => {
      const values: Record<string, string> = {
        PAWAPAY_MTN_PROVIDER: 'MTN_MOMO_COG',
        PAWAPAY_AIRTEL_PROVIDER: 'AIRTEL_COG',
        PAWAPAY_STATEMENT_PREFIX: 'LiliaFood',
      };
      return values[key] ?? fallback;
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PawaPayProvider,
        { provide: PawaPayHttpService, useValue: http },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    provider = module.get(PawaPayProvider);
  });

  const collectionInput = {
    paymentId: 'pay-1',
    providerTransactionId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    amountXaf: 6400,
    currency: 'XAF',
    phoneNumber: '061234567',
    method: 'MTN_MOMO' as const,
    orderRef: 'A1B2C3',
    vendorName: 'Chez Mère Lili',
  };

  // ══════════════════════════════════════════════════════════════════════════
  describe('encaissement (deposit)', () => {
    it('MTN : construit le corps exactement comme la spécification l’exige', async () => {
      http.post.mockResolvedValue({
        status: 200,
        data: {
          depositId: collectionInput.providerTransactionId,
          status: 'ACCEPTED',
        },
      });

      const result = await provider.createCollection(collectionInput);

      expect(http.post).toHaveBeenCalledWith('/v2/deposits', {
        depositId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
        payer: {
          type: 'MMO',
          accountDetails: {
            phoneNumber: '242061234567',
            provider: 'MTN_MOMO_COG',
          },
        },
        amount: '6400', // chaîne, entière : XAF n'a pas de sous-unité
        currency: 'XAF',
        clientReferenceId: 'pay-1',
        customerMessage: 'LiliaFood A1B2C3',
        metadata: [{ orderRef: 'A1B2C3' }, { paymentId: 'pay-1' }],
      });
      expect(result.accepted).toBe(true);
      expect(result.duplicate).toBe(false);
    });

    it('Airtel : bascule le code opérateur', async () => {
      http.post.mockResolvedValue({
        status: 200,
        data: { status: 'ACCEPTED' },
      });

      await provider.createCollection({
        ...collectionInput,
        method: 'AIRTEL_MONEY',
      });

      expect(http.post).toHaveBeenCalledWith(
        '/v2/deposits',
        expect.objectContaining({
          payer: expect.objectContaining({
            accountDetails: expect.objectContaining({
              provider: 'AIRTEL_COG',
            }),
          }),
        }),
      );
    });

    it('DUPLICATE_IGNORED compte comme une acceptation', async () => {
      // C'est précisément ce qui protège du double débit quand le client
      // réessaie : la demande est déjà prise en charge, il n'y a rien à refaire.
      http.post.mockResolvedValue({
        status: 200,
        data: { status: 'DUPLICATE_IGNORED' },
      });

      const result = await provider.createCollection(collectionInput);

      expect(result.accepted).toBe(true);
      expect(result.duplicate).toBe(true);
    });

    it('REJECTED → refus métier avec son code, sans exception', async () => {
      http.post.mockResolvedValue({
        status: 200,
        data: {
          status: 'REJECTED',
          failureReason: {
            failureCode: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
            failureMessage: 'MTN indisponible',
          },
        },
      });

      const result = await provider.createCollection(collectionInput);

      expect(result.accepted).toBe(false);
      expect(result.failureCode).toBe('PROVIDER_TEMPORARILY_UNAVAILABLE');
    });

    it('numéro invalide : refusé localement, sans appel facturé', async () => {
      const result = await provider.createCollection({
        ...collectionInput,
        phoneNumber: '123',
      });

      expect(result.accepted).toBe(false);
      expect(result.failureCode).toBe('INVALID_PHONE_NUMBER');
      expect(http.post).not.toHaveBeenCalled();
    });

    it('panne réseau → ProviderUnavailableError (rejouable)', async () => {
      http.post.mockRejectedValue(
        new ProviderUnavailableError('injoignable', 503),
      );

      await expect(
        provider.createCollection(collectionInput),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    });

    it('réponse inexploitable → panne, jamais un succès supposé', async () => {
      http.post.mockResolvedValue({ status: 200, data: {} });

      await expect(
        provider.createCollection(collectionInput),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('statut d’encaissement', () => {
    it('COMPLETED → SUCCESS avec le montant, pour le contrôle anti-écart', async () => {
      http.get.mockResolvedValue({
        status: 200,
        data: {
          status: 'FOUND',
          data: {
            depositId: 'dep-1',
            status: 'COMPLETED',
            amount: '6400',
            requestedAmount: '6400',
            currency: 'XAF',
            providerTransactionId: 'MTN-123',
          },
        },
      });

      const status = await provider.getCollectionStatus('dep-1');

      expect(status).toMatchObject({
        state: 'SUCCESS',
        rawStatus: 'COMPLETED',
        amountXaf: 6400,
        currency: 'XAF',
        providerTransactionId: 'MTN-123',
      });
    });

    it('NOT_FOUND → null (on ne conclut rien)', async () => {
      http.get.mockResolvedValue({
        status: 200,
        data: { status: 'NOT_FOUND' },
      });
      await expect(provider.getCollectionStatus('inconnu')).resolves.toBeNull();
    });

    it.each(['ACCEPTED', 'PROCESSING', 'IN_RECONCILIATION'])(
      '%s reste PENDING — surtout pas un échec',
      async (rawStatus) => {
        http.get.mockResolvedValue({
          status: 200,
          data: {
            status: 'FOUND',
            data: { status: rawStatus, amount: '6400' },
          },
        });

        const status = await provider.getCollectionStatus('dep-1');
        expect(status?.state).toBe('PENDING');
      },
    );

    it('FAILED remonte le motif', async () => {
      http.get.mockResolvedValue({
        status: 200,
        data: {
          status: 'FOUND',
          data: {
            status: 'FAILED',
            amount: '6400',
            failureReason: {
              failureCode: 'PAYMENT_NOT_APPROVED',
              failureMessage: 'Le client n’a pas approuvé',
            },
          },
        },
      });

      const status = await provider.getCollectionStatus('dep-1');
      expect(status).toMatchObject({
        state: 'FAILED',
        failureCode: 'PAYMENT_NOT_APPROVED',
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('reversement (payout)', () => {
    const payoutInput = {
      payoutId: 'po-1',
      providerPayoutId: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
      amountXaf: 4500,
      currency: 'XAF',
      phoneNumber: '242066543210',
      payoutProvider: 'MTN_MOMO' as const,
      orderRef: 'A1B2C3',
    };

    it('utilise `recipient` et `payoutId` — jamais `payer` ni `depositId`', async () => {
      http.post.mockResolvedValue({
        status: 200,
        data: { payoutId: payoutInput.providerPayoutId, status: 'ACCEPTED' },
      });

      await provider.createPayout(payoutInput);

      expect(http.post).toHaveBeenCalledWith('/v2/payouts', {
        payoutId: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
        recipient: {
          type: 'MMO',
          accountDetails: {
            phoneNumber: '242066543210',
            provider: 'MTN_MOMO_COG',
          },
        },
        amount: '4500',
        currency: 'XAF',
        clientReferenceId: 'po-1',
        customerMessage: 'LiliaFood A1B2C3',
        metadata: [{ orderRef: 'A1B2C3' }, { payoutId: 'po-1' }],
      });
    });

    it('numéro de vendeur invalide : refusé sans appel', async () => {
      const result = await provider.createPayout({
        ...payoutInput,
        phoneNumber: '000',
      });
      expect(result.accepted).toBe(false);
      expect(result.failureCode).toBe('INVALID_PHONE_NUMBER');
      expect(http.post).not.toHaveBeenCalled();
    });

    it('wallet à sec → refus métier explicite', async () => {
      http.post.mockResolvedValue({
        status: 200,
        data: {
          status: 'REJECTED',
          failureReason: {
            failureCode: 'PAWAPAY_WALLET_OUT_OF_FUNDS',
            failureMessage: 'Fonds insuffisants',
          },
        },
      });

      const result = await provider.createPayout(payoutInput);
      expect(result.accepted).toBe(false);
      expect(result.failureCode).toBe('PAWAPAY_WALLET_OUT_OF_FUNDS');
    });

    it('ENQUEUED reste PENDING (statut propre aux reversements)', async () => {
      http.get.mockResolvedValue({
        status: 200,
        data: { status: 'FOUND', data: { status: 'ENQUEUED', amount: '4500' } },
      });

      const status = await provider.getPayoutStatus('po-1');
      expect(status?.state).toBe('PENDING');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('pawapay.mapper', () => {
  describe('mapPawaPayState', () => {
    it('ne reconnaît que COMPLETED et FAILED comme terminaux', () => {
      expect(mapPawaPayState('COMPLETED')).toBe('SUCCESS');
      expect(mapPawaPayState('FAILED')).toBe('FAILED');
      for (const s of [
        'ACCEPTED',
        'ENQUEUED',
        'PROCESSING',
        'IN_RECONCILIATION',
        'UNKNOWN_FUTURE_STATUS',
      ]) {
        expect(mapPawaPayState(s)).toBe('PENDING');
      }
    });
  });

  describe('formatAmountForPawaPay', () => {
    it('rend une chaîne entière', () => {
      expect(formatAmountForPawaPay(6400)).toBe('6400');
      expect(formatAmountForPawaPay(1)).toBe('1');
    });

    it('refuse ce que pawaPay rejetterait', () => {
      expect(() => formatAmountForPawaPay(1250.5)).toThrow();
      expect(() => formatAmountForPawaPay(0)).toThrow();
      expect(() => formatAmountForPawaPay(-100)).toThrow();
      expect(() => formatAmountForPawaPay(NaN)).toThrow();
    });
  });

  describe('parseAmountToXaf', () => {
    it('lit les montants du prestataire', () => {
      expect(parseAmountToXaf('6400')).toBe(6400);
      expect(parseAmountToXaf('123.00')).toBe(123);
      expect(parseAmountToXaf('123.60')).toBe(124);
    });

    it('rend undefined sur une valeur inexploitable — un contrôle impossible se signale', () => {
      expect(parseAmountToXaf(undefined)).toBeUndefined();
      expect(parseAmountToXaf('')).toBeUndefined();
      expect(parseAmountToXaf('abc')).toBeUndefined();
    });
  });

  describe('sanitizeCustomerMessage', () => {
    it('respecte les contraintes du prestataire : 4-22 caractères alphanumériques', () => {
      const result = sanitizeCustomerMessage('Chez Mère Lili — commande #A1B2');
      expect(result).toMatch(/^[a-zA-Z0-9 ]+$/);
      expect(result.length).toBeLessThanOrEqual(22);
      expect(result.length).toBeGreaterThanOrEqual(4);
    });

    it('retire les diacritiques plutôt que de les supprimer', () => {
      expect(sanitizeCustomerMessage('Mère Lili')).toBe('Mere Lili');
    });

    it('retombe sur le libellé par défaut si le nettoyage vide la chaîne', () => {
      expect(sanitizeCustomerMessage('—#@')).toBe('Lilia Food');
      expect(sanitizeCustomerMessage('ab')).toBe('Lilia Food');
    });
  });

  describe('toMsisdn / isValidCongoMsisdn', () => {
    it.each([
      ['061234567', '242061234567'],
      ['0612 34 567', '242061234567'],
      ['+242061234567', '242061234567'],
      ['00242061234567', '242061234567'],
      ['242061234567', '242061234567'],
    ])('%s → %s', (input, expected) => {
      expect(toMsisdn(input)).toBe(expected);
    });

    it('valide les mobiles congolais et rejette le reste', () => {
      expect(isValidCongoMsisdn('242061234567')).toBe(true);
      expect(isValidCongoMsisdn('242051234567')).toBe(true);
      expect(isValidCongoMsisdn('242041234567')).toBe(true);
      expect(isValidCongoMsisdn('242011234567')).toBe(false); // préfixe invalide
      expect(isValidCongoMsisdn('24206123456')).toBe(false); // trop court
      expect(isValidCongoMsisdn('33612345678')).toBe(false); // hors Congo
    });
  });
});
