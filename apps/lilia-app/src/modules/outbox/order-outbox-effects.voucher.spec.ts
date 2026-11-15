import { OrderOutboxEffectsService } from './order-outbox-effects.service';

/**
 * Arbitrage de livraison (15/11/2026) — l'avoir offert au client lui est
 * annoncé par un push portant son code. Sans ce message, rien ne le lui
 * montre : l'obligation est donc durable (outbox) et rejouable.
 */
describe('OrderOutboxEffectsService — avoir émis', () => {
  function build(promo: Record<string, unknown> | null) {
    const prisma = {
      promoCode: { findUnique: jest.fn().mockResolvedValue(promo) },
    };
    const outbox = { markSent: jest.fn(), markFailed: jest.fn() };
    const notifications = {
      sendPushNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = new OrderOutboxEffectsService(
      prisma as never,
      outbox as never,
      { registerHandler: jest.fn() } as never,
      notifications as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, outbox, notifications };
  }

  const event = (payload: unknown) =>
    ({
      id: 'evt-v',
      type: 'order.voucher_issued',
      aggregateId: 'order-1',
      payload,
    }) as never;

  it('push au bénéficiaire avec le code et le montant, puis acquitte', async () => {
    const { service, outbox, notifications } = build({
      code: 'AVOIR-ABCD2345',
      discountValue: 2500,
      expiresAt: new Date('2026-12-15T12:00:00Z'),
      assignedUserId: 'u-client',
    });

    await service.dispatchVoucherIssued(event({ promoCodeId: 'promo-1' }));

    expect(notifications.sendPushNotification).toHaveBeenCalledTimes(1);
    const [userId, , body, data] =
      notifications.sendPushNotification.mock.calls[0];
    expect(userId).toBe('u-client');
    expect(body).toContain('AVOIR-ABCD2345');
    expect(body).toContain('2500 FCFA');
    expect(body).toContain('15/12/2026');
    expect(data).toEqual({ orderId: 'order-1', type: 'voucher_issued' });
    expect(outbox.markSent).toHaveBeenCalledWith('evt-v');
  });

  it('avoir introuvable ou sans bénéficiaire : échec tracé, aucun push', async () => {
    for (const promo of [null, { code: 'X', assignedUserId: null }]) {
      const { service, outbox, notifications } = build(promo);
      await service.dispatchVoucherIssued(event({ promoCodeId: 'promo-1' }));
      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalled();
    }
  });

  it('payload sans identifiant : aucune lecture, échec tracé', async () => {
    const { service, prisma, outbox } = build(null);
    await service.dispatchVoucherIssued(event({}));
    expect(prisma.promoCode.findUnique).not.toHaveBeenCalled();
    expect(outbox.markFailed).toHaveBeenCalled();
  });

  it('push en échec : l’obligation reste ouverte (exception propagée)', async () => {
    const { service, outbox, notifications } = build({
      code: 'AVOIR-ABCD2345',
      discountValue: 2500,
      expiresAt: null,
      assignedUserId: 'u-client',
    });
    notifications.sendPushNotification.mockRejectedValueOnce(
      new Error('FCM indisponible'),
    );
    await expect(
      service.dispatchVoucherIssued(event({ promoCodeId: 'promo-1' })),
    ).rejects.toThrow('FCM indisponible');
    expect(outbox.markSent).not.toHaveBeenCalled();
  });
});
