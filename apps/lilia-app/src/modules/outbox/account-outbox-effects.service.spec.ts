import { AccountOutboxEffectsService } from './account-outbox-effects.service';

/**
 * F3-12.1 R7 — coupure du compte quand un ban différé s'applique. Relue en
 * base : un compte débanni entre-temps n'est jamais coupé.
 */
describe('AccountOutboxEffectsService — ban différé appliqué', () => {
  const prisma = { user: { findUnique: jest.fn() } };
  const outbox = { markSent: jest.fn(), markFailed: jest.fn() };
  const dispatcher = { registerHandler: jest.fn() };
  const firebase = { setUserDisabled: jest.fn(), revokeUserTokens: jest.fn() };
  const userCache = { invalidateOrThrow: jest.fn() };
  const service = new AccountOutboxEffectsService(
    prisma as never,
    outbox as never,
    dispatcher as never,
    firebase as never,
    userCache as never,
  );
  const event = { id: 'ev-1', aggregateId: 'u1' } as never;

  beforeEach(() => jest.clearAllMocks());

  it('s’inscrit auprès du dispatcher', () => {
    service.onModuleInit();
    expect(dispatcher.registerHandler).toHaveBeenCalledWith(
      'user.ban.applied',
      expect.any(Function),
    );
  });

  it('compte BLOCKED : Firebase désactivé, jetons révoqués, cache purgé, acquitté', async () => {
    prisma.user.findUnique.mockResolvedValue({
      firebaseUid: 'fb1',
      statusUser: 'BLOCKED',
    });
    await service.dispatchBanApplied(event);
    expect(firebase.setUserDisabled).toHaveBeenCalledWith('fb1', true);
    expect(firebase.revokeUserTokens).toHaveBeenCalledWith('fb1');
    expect(userCache.invalidateOrThrow).toHaveBeenCalledWith('fb1');
    expect(outbox.markSent).toHaveBeenCalledWith('ev-1');
  });

  it('débanni entre-temps : rien n’est coupé, l’obligation est close', async () => {
    prisma.user.findUnique.mockResolvedValue({
      firebaseUid: 'fb1',
      statusUser: 'ACTIVE',
    });
    await service.dispatchBanApplied(event);
    expect(firebase.setUserDisabled).not.toHaveBeenCalled();
    expect(outbox.markSent).toHaveBeenCalledWith('ev-1');
  });

  it('échec Firebase : l’erreur remonte (le dispatcher rejoue), rien n’est acquitté', async () => {
    prisma.user.findUnique.mockResolvedValue({
      firebaseUid: 'fb1',
      statusUser: 'BLOCKED',
    });
    firebase.setUserDisabled.mockRejectedValueOnce(new Error('réseau'));
    await expect(service.dispatchBanApplied(event)).rejects.toThrow('réseau');
    expect(outbox.markSent).not.toHaveBeenCalled();
  });
});
