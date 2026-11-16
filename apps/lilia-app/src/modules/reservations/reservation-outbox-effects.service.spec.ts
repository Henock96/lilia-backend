import { OutboxEvent } from '@prisma/client';

import { ReservationOutboxEffectsService } from './reservation-outbox-effects.service';

/**
 * Un avis de réservation n'est acquitté que s'il a atteint au moins un
 * appareil (revue « échecs silencieux » du 18/10) : sinon le dispatcher le
 * retente puis le marque FAILED, au lieu d'un SENT mensonger.
 */
describe('ReservationOutboxEffectsService', () => {
  const event = {
    id: 'evt-1',
    payload: {
      notice: 'REQUESTED',
      audience: 'VENDOR',
      recipientUserId: 'owner-1',
      restaurantName: 'Chez Mama',
      reservationId: 'res-1',
      arrivalAt: '2026-10-20T11:00:00.000Z',
      partySize: 2,
    },
  } as unknown as OutboxEvent;

  const build = (result: { sent: number; failed: number; devices: number }) => {
    const outbox = { markSent: jest.fn() };
    const notifications = {
      sendPushToUsers: jest.fn().mockResolvedValue(result),
    };
    const service = new ReservationOutboxEffectsService(
      outbox as never,
      { registerHandler: jest.fn() } as never,
      notifications as never,
    );
    return { service, outbox, notifications };
  };

  it('acquitte quand au moins un appareil a reçu le push', async () => {
    const { service, outbox, notifications } = build({
      sent: 1,
      failed: 1,
      devices: 2,
    });
    await service.dispatch(event);
    expect(notifications.sendPushToUsers).toHaveBeenCalledWith(
      ['owner-1'],
      '🍽️ Nouvelle demande de réservation',
      expect.stringContaining('2 personnes'),
      {
        type: 'reservation_update',
        reservationId: 'res-1',
        notice: 'REQUESTED',
      },
    );
    expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
  });

  it.each([
    ['aucun jeton FCM', { sent: 0, failed: 0, devices: 0 }],
    ['tous les envois en échec', { sent: 0, failed: 2, devices: 2 }],
  ])('%s : lève (le dispatcher retentera) et n’acquitte pas', async (_, r) => {
    const { service, outbox } = build(r);
    await expect(service.dispatch(event)).rejects.toThrow('non remis');
    expect(outbox.markSent).not.toHaveBeenCalled();
  });
});
