import { ExecutionContext, HttpException } from '@nestjs/common';
import { MinAppVersionGuard } from './min-app-version.guard';
import { PlatformSettingsService } from '../platform-settings.service';

function contextWith(headers: Record<string, string | string[]>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('MinAppVersionGuard (UPD-003)', () => {
  let settings: { getSettings: jest.Mock };
  let guard: MinAppVersionGuard;

  beforeEach(() => {
    settings = {
      getSettings: jest.fn().mockResolvedValue({ minAppVersion: '1.3.1' }),
    };
    guard = new MinAppVersionGuard(
      settings as unknown as PlatformSettingsService,
    );
  });

  it('laisse passer un client sans en-tête (anciens binaires, site web)', async () => {
    await expect(guard.canActivate(contextWith({}))).resolves.toBe(true);
  });

  it('laisse passer un en-tête illisible — ce n’est pas un seuil', async () => {
    await expect(
      guard.canActivate(contextWith({ 'x-lilia-app-version': 'n/a' })),
    ).resolves.toBe(true);
  });

  it('laisse passer quand aucun blocage n’est posé', async () => {
    settings.getSettings.mockResolvedValue({ minAppVersion: null });
    await expect(
      guard.canActivate(contextWith({ 'x-lilia-app-version': '1.0.0+1' })),
    ).resolves.toBe(true);
  });

  it.each(['1.3.1', '1.3.1+35', '1.4.0', '1.10.0'])(
    'laisse passer %s (au seuil ou au-dessus)',
    async (version) => {
      await expect(
        guard.canActivate(contextWith({ 'x-lilia-app-version': version })),
      ).resolves.toBe(true);
    },
  );

  it.each(['1.3.0+34', '1.2.9', '0.9.0'])(
    'refuse %s en 426 avec un code exploitable',
    async (version) => {
      const err = await guard
        .canActivate(contextWith({ 'x-lilia-app-version': version }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(426);
      expect((err as HttpException).getResponse()).toMatchObject({
        code: 'APP_UPDATE_REQUIRED',
      });
    },
  );

  it('compare numériquement : 1.9.0 est sous 1.10.0', async () => {
    settings.getSettings.mockResolvedValue({ minAppVersion: '1.10.0' });
    await expect(
      guard.canActivate(contextWith({ 'x-lilia-app-version': '1.9.0' })),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
