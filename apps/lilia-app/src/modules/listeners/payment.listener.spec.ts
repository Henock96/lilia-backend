import { Test, TestingModule } from '@nestjs/testing';

import { PaymentListener } from './payment.listener';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReferralService } from '../users/referral.service';

/**
 * Ce que le client lit quand un paiement échoue.
 *
 * Une notification est le seul message que le client reçoit sans avoir rien
 * demandé, et le seul qu'il ne peut pas fermer sans l'avoir lu. Elle a affiché
 * en production :
 *
 * ```
 * Le paiement de votre commande chez … n'a pas abouti :
 * "Airtel_CG" did not specify a reason for this faliure. Vous pouvez réessayer.
 * ```
 *
 * Le listener interpolait `event.reason`, qui vaut `failureMessage ??
 * failureCode` — le texte brut de l'opérateur, faute d'orthographe comprise.
 */
describe('PaymentListener — notification d’échec', () => {
  let listener: PaymentListener;

  const notifications = { sendPushNotification: jest.fn() };
  const prisma = { order: { findUnique: jest.fn() } };
  const referral = { rewardIfFirstPaidOrder: jest.fn() };

  /** Le motif exact observé en production. */
  const RAW_PROVIDER_REASON =
    '"Airtel_CG" did not specify a reason for this faliure';

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.order.findUnique.mockResolvedValue({
      restaurant: { nom: 'Chez Maman Lili' },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentListener,
        { provide: NotificationsService, useValue: notifications },
        { provide: PrismaService, useValue: prisma },
        { provide: ReferralService, useValue: referral },
      ],
    }).compile();

    listener = module.get(PaymentListener);
  });

  const fail = (reason: string) =>
    listener.handlePaymentFailed({
      orderId: 'o1',
      userId: 'u1',
      paymentId: 'p1',
      reason,
    });

  const lastPush = () => {
    const calls = notifications.sendPushNotification.mock.calls;
    const [, title, body, data] = calls[calls.length - 1] ?? [];
    return { title, body, data } as {
      title: string;
      body: string;
      data: Record<string, unknown>;
    };
  };

  it('⚠️ ne recopie JAMAIS le motif du prestataire dans le message', async () => {
    await fail(RAW_PROVIDER_REASON);

    const { body } = lastPush();
    expect(body).not.toContain('Airtel_CG');
    expect(body).not.toContain('faliure');
    expect(body).not.toContain(RAW_PROVIDER_REASON);
  });

  it('ne le glisse pas non plus dans le payload de données', async () => {
    // Le payload est lisible par l'application : y laisser le motif brut
    // rouvrirait la même fuite par une autre porte, le jour où quelqu'un
    // déciderait de l'afficher.
    await fail(RAW_PROVIDER_REASON);

    expect(JSON.stringify(lastPush().data)).not.toContain('Airtel_CG');
  });

  it('dit ce qui compte pour le client : rien n’a été prélevé, il peut réessayer', async () => {
    await fail(RAW_PROVIDER_REASON);

    const { title, body } = lastPush();
    expect(title).toContain('Paiement non abouti');
    expect(body).toContain('Chez Maman Lili');
    expect(body).toContain('réessayer');
    expect(body.toLowerCase()).toContain('aucun montant');
  });

  it.each([
    ['un code technique', 'UNSPECIFIED_FAILURE'],
    ['un message anglais', 'The transaction was declined by the provider'],
    ['une trace', 'Error: connect ETIMEDOUT 10.0.0.1:443'],
  ])(
    'quel que soit le motif reçu (%s), le message reste le même',
    async (_label, reason) => {
      await fail(reason);
      expect(lastPush().body).not.toContain(reason);
    },
  );

  it('conserve orderId et paymentId — le support en a besoin', async () => {
    await fail(RAW_PROVIDER_REASON);

    expect(lastPush().data).toMatchObject({
      orderId: 'o1',
      paymentId: 'p1',
      type: 'payment_failed',
    });
  });

  it('une commande introuvable ne fait pas lever le listener', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    await expect(fail(RAW_PROVIDER_REASON)).resolves.toBeUndefined();
    expect(notifications.sendPushNotification).not.toHaveBeenCalled();
  });
});
