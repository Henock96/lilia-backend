import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminCapability } from '@prisma/client';

import { AdminSecurityGuard } from './admin-security.guard';

/**
 * F3-08 — la garde des gestes financiers : capacité, puis (interrupteur
 * `ADMIN_MFA_REQUIRED`) second facteur et authentification récente.
 */
describe('AdminSecurityGuard', () => {
  const verifyIdToken = jest.fn();
  const firebase = { getAuth: () => ({ verifyIdToken }) };

  function build(opts: {
    capability?: AdminCapability;
    mfa?: boolean;
    role?: string;
    capabilities?: AdminCapability[];
    token?: Record<string, unknown>;
  }) {
    const reflector = {
      getAllAndOverride: () => opts.capability,
    } as unknown as Reflector;
    const config = { get: () => (opts.mfa ? 'true' : undefined) };
    const guard = new AdminSecurityGuard(
      reflector,
      firebase as never,
      config as never,
    );
    const request = {
      user: {
        id: 'a1',
        role: opts.role ?? 'ADMIN',
        adminCapabilities: opts.capabilities ?? [],
      },
      firebaseUser: opts.token ?? {},
      headers: { authorization: 'Bearer tok' },
    };
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    };
    return () => guard.canActivate(context as never);
  }

  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => verifyIdToken.mockReset().mockResolvedValue({}));

  it('route sans capacité : laissée à RolesGuard', async () => {
    await expect(build({})()).resolves.toBe(true);
  });

  it('non-admin (route partagée avec le vendeur) : pas de capacité exigée', async () => {
    await expect(
      build({ capability: 'FINANCE_EXECUTE', role: 'RESTAURATEUR' })(),
    ).resolves.toBe(true);
  });

  it('admin sans la capacité : 403 CAPABILITY_REQUIRED', async () => {
    await expect(
      build({ capability: 'FINANCE_EXECUTE', capabilities: ['SUPPORT'] })(),
    ).rejects.toMatchObject({
      response: { code: 'CAPABILITY_REQUIRED' },
    });
  });

  it('admin avec la capacité, MFA éteinte : autorisé, aucun appel Firebase', async () => {
    await expect(
      build({
        capability: 'FINANCE_EXECUTE',
        capabilities: ['FINANCE_EXECUTE'],
      })(),
    ).resolves.toBe(true);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  describe('MFA allumée', () => {
    const cap = {
      capability: 'FINANCE_EXECUTE' as const,
      capabilities: ['FINANCE_EXECUTE' as const],
      mfa: true,
    };

    it('sans second facteur : 403 MFA_REQUIRED', async () => {
      await expect(
        build({ ...cap, token: { auth_time: now() } })(),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('geste financier, authentification de plus de 15 min : 401 MFA_STEP_UP_REQUIRED', async () => {
      await expect(
        build({
          ...cap,
          token: {
            firebase: { sign_in_second_factor: 'totp' },
            auth_time: now() - 20 * 60,
          },
        })(),
      ).rejects.toMatchObject({ response: { code: 'MFA_STEP_UP_REQUIRED' } });
    });

    it('geste financier récent : jeton revérifié avec checkRevoked', async () => {
      await expect(
        build({
          ...cap,
          token: {
            firebase: { sign_in_second_factor: 'totp' },
            auth_time: now(),
          },
        })(),
      ).resolves.toBe(true);
      expect(verifyIdToken).toHaveBeenCalledWith('tok', true);
    });

    it('jeton révoqué : 401', async () => {
      verifyIdToken.mockRejectedValue(new Error('revoked'));
      await expect(
        build({
          ...cap,
          token: {
            firebase: { sign_in_second_factor: 'totp' },
            auth_time: now(),
          },
        })(),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('SETTINGS : second facteur exigé, mais pas de step-up à 15 min', async () => {
      await expect(
        build({
          capability: 'SETTINGS',
          capabilities: ['SETTINGS'],
          mfa: true,
          token: {
            firebase: { sign_in_second_factor: 'totp' },
            auth_time: now() - 3600,
          },
        })(),
      ).resolves.toBe(true);
    });
  });
});
