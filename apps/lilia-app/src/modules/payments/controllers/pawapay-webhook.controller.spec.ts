import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { PawaPayWebhookController } from './pawapay-webhook.controller';
import { PaymentService } from '../services/payment.service';
import { RestaurantPayoutService } from '../services/restaurant-payout.service';
import { PaymentEventService } from '../services/payment-event.service';
import { PawaPaySignatureService } from '../providers/pawapay/pawapay-signature.service';
import { PawaPayCallbackDto } from '../dto/pawapay-webhook.dto';

/**
 * Webhooks pawaPay — authentification, aiguillage et convention de réponse.
 *
 * La convention de réponse n'est pas cosmétique : pawaPay rejoue pendant quinze
 * minutes tant qu'il ne reçoit pas `200`. Répondre `200` sur une panne de base
 * ferait considérer le callback comme livré, et le paiement ne serait **jamais**
 * confirmé — un client aurait payé, sa commande expirerait. C'est le défaut
 * corrigé sur le webhook MTN (fix M15), et il ne doit pas revenir par ici.
 */
describe('PawaPayWebhookController', () => {
  let controller: PawaPayWebhookController;

  const payments = {
    findByProviderTransactionId: jest.fn(),
    applyCollectionProviderStatus: jest.fn(),
  };
  const payouts = {
    findByProviderPayoutId: jest.fn(),
    applyPayoutProviderStatus: jest.fn(),
  };
  const events = { record: jest.fn().mockResolvedValue('evt-1') };

  let signatureEnabled = true;
  let signatureFailure: string | null = null;
  const signature = {
    get isEnabled() {
      return signatureEnabled;
    },
    verify: jest.fn(() => signatureFailure),
  };

  let allowlist = '';
  const config = {
    get: (key: string) =>
      key === 'PAWAPAY_CALLBACK_IPS' ? allowlist : undefined,
  };

  const req = (ip = '1.2.3.4'): Request =>
    ({
      method: 'POST',
      originalUrl: '/webhooks/pawapay/deposits',
      ip,
      headers: {},
      get: () => 'lilia-backend.onrender.com',
      rawBody: Buffer.from('{}'),
    }) as unknown as Request;

  const depositCallback = (
    overrides: Partial<PawaPayCallbackDto> = {},
  ): PawaPayCallbackDto =>
    ({
      depositId: 'dep-uuid',
      status: 'COMPLETED',
      amount: '6400',
      requestedAmount: '6400',
      currency: 'XAF',
      ...overrides,
    }) as PawaPayCallbackDto;

  beforeEach(async () => {
    jest.clearAllMocks();
    signatureEnabled = true;
    signatureFailure = null;
    allowlist = '';
    events.record.mockResolvedValue('evt-1');

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PawaPayWebhookController],
      providers: [
        { provide: PaymentService, useValue: payments },
        { provide: RestaurantPayoutService, useValue: payouts },
        { provide: PaymentEventService, useValue: events },
        { provide: PawaPaySignatureService, useValue: signature },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    controller = module.get(PawaPayWebhookController);
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('authentification', () => {
    it('signature invalide → 401, et RIEN n’est traité', async () => {
      signatureFailure = 'signature-mismatch';

      await expect(
        controller.handleDepositCallback(depositCallback(), req()),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(payments.findByProviderTransactionId).not.toHaveBeenCalled();
      expect(payments.applyCollectionProviderStatus).not.toHaveBeenCalled();
    });

    it('digest falsifié → 401', async () => {
      signatureFailure = 'content-digest-mismatch';
      await expect(
        controller.handleDepositCallback(depositCallback(), req()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('signature rejouée (trop ancienne) → 401', async () => {
      signatureFailure = 'signature-too-old';
      await expect(
        controller.handleDepositCallback(depositCallback(), req()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('sans clé ni liste blanche → 401 (fail-closed)', async () => {
      // Un endpoint public qui mute des lignes d'argent ne s'ouvre jamais
      // « en attendant la configuration ».
      signatureEnabled = false;
      allowlist = '';

      await expect(
        controller.handleDepositCallback(depositCallback(), req()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('repli liste blanche : IP autorisée → traité', async () => {
      signatureEnabled = false;
      allowlist = '9.9.9.9, 1.2.3.4';
      payments.findByProviderTransactionId.mockResolvedValue({ id: 'pay-1' });
      payments.applyCollectionProviderStatus.mockResolvedValue('APPLIED');

      const res = await controller.handleDepositCallback(
        depositCallback(),
        req('1.2.3.4'),
      );

      expect(res).toEqual({ status: 'processed' });
    });

    it('repli liste blanche : IP inconnue → 401', async () => {
      signatureEnabled = false;
      allowlist = '9.9.9.9';

      await expect(
        controller.handleDepositCallback(depositCallback(), req('1.2.3.4')),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('callback de dépôt', () => {
    it('COMPLETED sur un paiement connu → processed', async () => {
      payments.findByProviderTransactionId.mockResolvedValue({ id: 'pay-1' });
      payments.applyCollectionProviderStatus.mockResolvedValue('APPLIED');

      const res = await controller.handleDepositCallback(
        depositCallback(),
        req(),
      );

      expect(res).toEqual({ status: 'processed' });
      expect(payments.applyCollectionProviderStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: 'pay-1',
          status: expect.objectContaining({
            state: 'SUCCESS',
            rawStatus: 'COMPLETED',
            amountXaf: 6400,
            currency: 'XAF',
          }),
        }),
      );
    });

    it('rejeu → duplicate, HTTP 200 (pawaPay doit cesser de rejouer)', async () => {
      payments.findByProviderTransactionId.mockResolvedValue({ id: 'pay-1' });
      payments.applyCollectionProviderStatus.mockResolvedValue('DUPLICATE');

      const res = await controller.handleDepositCallback(
        depositCallback(),
        req(),
      );
      expect(res).toEqual({ status: 'duplicate' });
    });

    it('écart de montant → mismatch, HTTP 200 (rejouer n’y changerait rien)', async () => {
      payments.findByProviderTransactionId.mockResolvedValue({ id: 'pay-1' });
      payments.applyCollectionProviderStatus.mockResolvedValue('MISMATCH');

      const res = await controller.handleDepositCallback(
        depositCallback({ amount: '99999' }),
        req(),
      );
      expect(res).toEqual({ status: 'mismatch' });
    });

    it('transaction inconnue → ignored 200, mais la trace est gardée', async () => {
      payments.findByProviderTransactionId.mockResolvedValue(null);

      const res = await controller.handleDepositCallback(
        depositCallback(),
        req(),
      );

      expect(res).toMatchObject({ status: 'ignored' });
      // Une référence inconnue signale un environnement croisé, une fuite de
      // configuration ou une tentative : on la journalise.
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'IGNORED', externalId: 'dep-uuid' }),
      );
    });

    it('sans depositId → ignored, sans lever', async () => {
      const res = await controller.handleDepositCallback(
        depositCallback({ depositId: undefined }),
        req(),
      );
      expect(res).toMatchObject({ status: 'ignored' });
    });

    it('panne de base → 5xx pour que pawaPay rejoue', async () => {
      payments.findByProviderTransactionId.mockRejectedValue(
        new Error('connection terminated'),
      );

      await expect(
        controller.handleDepositCallback(depositCallback(), req()),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('ne traite JAMAIS un dépôt comme un reversement', async () => {
      payments.findByProviderTransactionId.mockResolvedValue({ id: 'pay-1' });
      payments.applyCollectionProviderStatus.mockResolvedValue('APPLIED');

      await controller.handleDepositCallback(depositCallback(), req());

      expect(payouts.applyPayoutProviderStatus).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('callback de reversement', () => {
    const payoutCallback = (overrides: Partial<PawaPayCallbackDto> = {}) =>
      ({
        payoutId: 'po-uuid',
        status: 'COMPLETED',
        amount: '4500',
        requestedAmount: '4500',
        currency: 'XAF',
        ...overrides,
      }) as PawaPayCallbackDto;

    it('COMPLETED sur un reversement connu → processed', async () => {
      payouts.findByProviderPayoutId.mockResolvedValue({ id: 'pay-out-1' });
      payouts.applyPayoutProviderStatus.mockResolvedValue('APPLIED');

      const res = await controller.handlePayoutCallback(
        payoutCallback(),
        req(),
      );

      expect(res).toEqual({ status: 'processed' });
      expect(payouts.applyPayoutProviderStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          payoutId: 'pay-out-1',
          status: expect.objectContaining({
            state: 'SUCCESS',
            amountXaf: 4500,
          }),
        }),
      );
    });

    it('ne traite JAMAIS un reversement comme un encaissement', async () => {
      payouts.findByProviderPayoutId.mockResolvedValue({ id: 'pay-out-1' });
      payouts.applyPayoutProviderStatus.mockResolvedValue('APPLIED');

      await controller.handlePayoutCallback(payoutCallback(), req());

      expect(payments.applyCollectionProviderStatus).not.toHaveBeenCalled();
    });

    it('reversement inconnu → ignored, journalisé', async () => {
      payouts.findByProviderPayoutId.mockResolvedValue(null);

      const res = await controller.handlePayoutCallback(
        payoutCallback(),
        req(),
      );

      expect(res).toMatchObject({ status: 'ignored' });
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'PAYOUT', outcome: 'IGNORED' }),
      );
    });

    it('statut non terminal → ignored, rien ne bouge', async () => {
      payouts.findByProviderPayoutId.mockResolvedValue({ id: 'pay-out-1' });
      payouts.applyPayoutProviderStatus.mockResolvedValue('IGNORED');

      const res = await controller.handlePayoutCallback(
        payoutCallback({ status: 'PROCESSING' }),
        req(),
      );
      expect(res).toEqual({ status: 'ignored' });
    });
  });
});
