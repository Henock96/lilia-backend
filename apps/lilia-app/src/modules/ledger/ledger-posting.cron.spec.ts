import { LedgerPostingCron } from './ledger-posting.cron';

/**
 * Lot 2 — l'interrupteur `LEDGER_POSTING_ENABLED` est éteint par défaut, et
 * lu à chaque passage : éteint, le cron ne touche ni au verrou ni à la base.
 */
describe('LedgerPostingCron', () => {
  const poster = { catchUp: jest.fn() };
  const cronLock = {
    runExclusively: jest.fn((_n: string, _t: number, task: () => unknown) =>
      task(),
    ),
  };
  const make = (flag: unknown) =>
    new LedgerPostingCron(
      poster as never,
      cronLock as never,
      { get: () => flag } as never,
    );

  beforeEach(() => jest.clearAllMocks());

  it.each([undefined, false, 'false', ''])(
    'éteint (%p) : aucun passage',
    async (flag) => {
      await make(flag).run();
      expect(cronLock.runExclusively).not.toHaveBeenCalled();
      expect(poster.catchUp).not.toHaveBeenCalled();
    },
  );

  it.each([true, 'true'])(
    'allumé (%p) : un passage sous verrou',
    async (flag) => {
      poster.catchUp.mockResolvedValue({
        collections: { posted: 1, exceptions: 0 },
      });
      await make(flag).run();
      expect(cronLock.runExclusively).toHaveBeenCalledWith(
        'ledger-posting',
        540,
        expect.any(Function),
      );
      expect(poster.catchUp).toHaveBeenCalledTimes(1);
    },
  );

  it('un passage en échec ne fait pas tomber le processus', async () => {
    poster.catchUp.mockRejectedValue(new Error('base indisponible'));
    await expect(make(true).runUnlocked()).resolves.toBeUndefined();
  });
});
