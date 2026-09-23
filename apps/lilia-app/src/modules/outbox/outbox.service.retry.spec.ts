import { OutboxService } from './outbox.service';

/**
 * Relance plafonnée par une échéance (F3-01) : le backoff exponentiel reste la
 * règle, mais une relance ne doit jamais tomber APRÈS l'instant où un rappel
 * est dû — sinon le rappel part trop tard pour servir.
 */
describe('OutboxService.scheduleRetry — plafond', () => {
  const NOW = new Date('2026-09-24T12:00:00.000Z');
  beforeAll(() => jest.useFakeTimers({ now: NOW.getTime() }));
  afterAll(() => jest.useRealTimers());

  function build() {
    const update = jest.fn().mockResolvedValue({});
    const service = new OutboxService({ outboxEvent: { update } } as never);
    return { service, update };
  }
  const nextAttemptAt = (update: jest.Mock) =>
    (update.mock.calls[0][0] as { data: { nextAttemptAt: Date } }).data
      .nextAttemptAt;

  it('sans plafond : backoff exponentiel (4ᵉ tentative → 4 min)', async () => {
    const { service, update } = build();
    await service.scheduleRetry('e1', 3, 'x');
    expect(nextAttemptAt(update)).toEqual(new Date(NOW.getTime() + 240_000));
  });

  it('plafond plus proche que le backoff : la relance tombe au plafond', async () => {
    const { service, update } = build();
    const notAfter = new Date(NOW.getTime() + 60_000);
    await service.scheduleRetry('e1', 3, 'x', notAfter);
    expect(nextAttemptAt(update)).toEqual(notAfter);
  });

  it('plafond déjà passé : relance immédiate, jamais dans le passé', async () => {
    const { service, update } = build();
    await service.scheduleRetry('e1', 3, 'x', new Date(NOW.getTime() - 60_000));
    expect(nextAttemptAt(update)).toEqual(NOW);
  });

  it('plafond plus lointain que le backoff : le backoff reste la règle', async () => {
    const { service, update } = build();
    await service.scheduleRetry(
      'e1',
      0,
      'x',
      new Date(NOW.getTime() + 3_600_000),
    );
    expect(nextAttemptAt(update)).toEqual(new Date(NOW.getTime() + 30_000));
  });
});
