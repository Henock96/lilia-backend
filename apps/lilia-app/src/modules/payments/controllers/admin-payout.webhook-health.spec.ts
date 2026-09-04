import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { AdminPayoutController } from './admin-payout.controller';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminAuditService } from '../../admin-audit/admin-audit.service';
import { RestaurantPayoutService } from '../services/restaurant-payout.service';
import { PaymentEventService } from '../services/payment-event.service';
import { PawaPaySignatureService } from '../providers/pawapay/pawapay-signature.service';
import { PlatformSettingsService } from '../../platform-settings/platform-settings.service';

/**
 * `GET /admin/payments/webhook-health` — le diagnostic qui manquait.
 *
 * Un webhook prestataire non configuré est **silencieux** : les paiements
 * continuent d'être confirmés par le sondage du client et par le cron de
 * réconciliation. L'audit du 4 septembre 2026 a dû interroger la base de
 * production en SQL pour découvrir que zéro callback n'était jamais arrivé.
 * Cette route existe pour que ce constat tienne dans un appel authentifié.
 */
describe('AdminPayoutController — webhookHealth', () => {
  let controller: AdminPayoutController;

  const events = {
    countBySource: jest.fn(),
    lastWebhookAt: jest.fn(),
  };
  const prisma = {
    paymentEvent: { count: jest.fn() },
    restaurant: { findMany: jest.fn() },
    order: { groupBy: jest.fn() },
  };
  const settingsService = {
    getSettings: jest
      .fn()
      .mockResolvedValue({ restaurantCommissionPercent: 10 }),
  };

  let signatureEnabled = false;
  const signature = {
    get isEnabled() {
      return signatureEnabled;
    },
  };

  let env: Record<string, string | undefined> = {};
  const config = { get: (key: string) => env[key] };

  beforeEach(async () => {
    jest.clearAllMocks();
    signatureEnabled = false;
    env = { PAYMENT_MODE: 'PAWAPAY' };
    events.countBySource.mockResolvedValue({
      INITIATION: 20,
      CLIENT_POLL: 84,
      RECONCILIATION: 8,
      WEBHOOK: 0,
    });
    events.lastWebhookAt.mockResolvedValue(null);
    prisma.paymentEvent.count.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminPayoutController],
      providers: [
        { provide: RestaurantPayoutService, useValue: {} },
        { provide: PaymentEventService, useValue: events },
        { provide: AdminAuditService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: PawaPaySignatureService, useValue: signature },
        { provide: ConfigService, useValue: config },
        { provide: PlatformSettingsService, useValue: settingsService },
      ],
    }).compile();

    controller = module.get(AdminPayoutController);
  });

  it('reproduit le constat de l’audit : 0 webhook, jamais', async () => {
    const { data } = await controller.webhookHealth();

    expect(data.eventsBySource.WEBHOOK).toBe(0);
    expect(data.webhooksEverReceived).toBe(0);
    expect(data.lastWebhookAt).toBeNull();
    // Le critère de sortie du blocker P0-3 tient dans ce champ.
  });

  it('signale un webhook fail-closed : aucun dispositif armé', async () => {
    // Ni clé publique, ni liste blanche → le contrôleur refuse TOUT en 401.
    // L'absence de signal est alors garantie, pas seulement probable.
    const { data } = await controller.webhookHealth();

    expect(data.authentication).toEqual({
      configured: false,
      signature: false,
      ipAllowlistEntries: 0,
    });
  });

  it('reconnaît une authentification par signature', async () => {
    signatureEnabled = true;
    const { data } = await controller.webhookHealth();
    expect(data.authentication.configured).toBe(true);
    expect(data.authentication.signature).toBe(true);
  });

  it('reconnaît le repli par liste blanche d’IP, et en compte les entrées', async () => {
    env.PAWAPAY_CALLBACK_IPS = ' 3.64.89.224 , 18.192.9.10 ,';
    const { data } = await controller.webhookHealth();
    expect(data.authentication).toEqual({
      configured: true,
      signature: false,
      ipAllowlistEntries: 2,
    });
  });

  it('rend les URL de callback à recopier dans le tableau de bord pawaPay', async () => {
    // Sans préfixe `/payments` : l'app monte `@Controller('webhooks/pawapay')`.
    const { data } = await controller.webhookHealth();
    expect(data.callbackUrls).toEqual({
      deposits: '/webhooks/pawapay/deposits',
      payouts: '/webhooks/pawapay/payouts',
    });
  });

  it('borne la fenêtre demandée', async () => {
    expect((await controller.webhookHealth('0')).data.windowDays).toBe(7);
    expect((await controller.webhookHealth('365')).data.windowDays).toBe(90);
    expect((await controller.webhookHealth('30')).data.windowDays).toBe(30);
    expect((await controller.webhookHealth('abc')).data.windowDays).toBe(7);
  });

  describe('vendorPayoutAccounts (P0-1)', () => {
    beforeEach(() => {
      prisma.restaurant.findMany.mockResolvedValue([
        {
          id: 'v1',
          nom: 'Chez Maman Lili',
          isActive: true,
          adminApproved: true,
          onboardingStatus: 'ACTIVATED',
          payoutPhoneNumber: null,
          payoutProvider: null,
          payoutAccountName: null,
          payoutVerifiedAt: null,
          commissionPercent: null,
        },
        {
          id: 'v2',
          nom: 'Best Food Bistrot',
          isActive: true,
          adminApproved: true,
          onboardingStatus: 'ACTIVATED',
          payoutPhoneNumber: '242060000002',
          payoutProvider: 'MTN_MOMO_COG',
          payoutAccountName: 'Best Food SARL',
          payoutVerifiedAt: new Date('2026-09-04T09:00:00Z'),
          commissionPercent: 12,
        },
      ]);
      prisma.order.groupBy.mockResolvedValue([
        { restaurantId: 'v1', _count: { _all: 7 }, _sum: { subTotal: 48_000 } },
      ]);
    });

    it('distingue les vendeurs payables de ceux qui ne le sont pas', async () => {
      const { data } = await controller.vendorPayoutAccounts();
      expect(data.map((v) => [v.nom, v.payable])).toEqual([
        ['Chez Maman Lili', false],
        ['Best Food Bistrot', true],
      ]);
    });

    it('chiffre la dette déjà accumulée envers un vendeur impayable', async () => {
      // C'est ce nombre qui rend le problème urgent plutôt que théorique.
      const { data } = await controller.vendorPayoutAccounts();
      expect(data[0].unpaidOrders).toBe(7);
      expect(data[0].unpaidSubTotal).toBe(48_000);
    });

    it('ne compte aucune dette pour un vendeur sans commande impayée', async () => {
      const { data } = await controller.vendorPayoutAccounts();
      expect(data[1].unpaidOrders).toBe(0);
      expect(data[1].unpaidSubTotal).toBe(0);
    });

    it('résout `commissionPercent: null` en taux plateforme, et le dit', async () => {
      const { data } = await controller.vendorPayoutAccounts();
      expect(data[0].commissionPercent).toBe(10);
      expect(data[0].commissionIsPlatformDefault).toBe(true);
      expect(data[1].commissionPercent).toBe(12);
      expect(data[1].commissionIsPlatformDefault).toBe(false);
    });

    it('masque le numéro de reversement', async () => {
      // La liste est un écran de supervision, pas une fiche de paiement.
      const { data } = await controller.vendorPayoutAccounts();
      expect(data[1].payoutPhoneNumber).not.toContain('242060000002');
    });
  });

  it('remonte un webhook reçu quand il y en a un', async () => {
    const at = new Date('2026-09-04T10:00:00Z');
    events.countBySource.mockResolvedValue({
      INITIATION: 21,
      CLIENT_POLL: 84,
      RECONCILIATION: 8,
      WEBHOOK: 2,
    });
    events.lastWebhookAt.mockResolvedValue(at);
    prisma.paymentEvent.count.mockResolvedValue(2);

    const { data } = await controller.webhookHealth();
    expect(data.webhooksEverReceived).toBe(2);
    expect(data.lastWebhookAt).toEqual(at);
  });
});
