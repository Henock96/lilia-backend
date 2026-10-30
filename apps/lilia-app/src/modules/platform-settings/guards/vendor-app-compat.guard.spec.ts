import { ExecutionContext, HttpException } from '@nestjs/common';

import { VendorAppCompatGuard } from './vendor-app-compat.guard';

/**
 * Lot 3 — « Ancienne application vendeurs : réponse maîtrisée ».
 *
 * Par défaut (aucun seuil, `PAY_FIRST`), rien n'est refusé : la garde ne
 * change pas le comportement de production à son déploiement.
 */
describe('VendorAppCompatGuard', () => {
  const settings = {
    minVendorAppVersion: null as string | null,
    orderFlow: 'PAY_FIRST',
  };
  const guard = new VendorAppCompatGuard({
    getSettings: async () => settings,
  } as never);

  const ctx = (
    role: string | undefined,
    headers: Record<string, string> = {},
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          user: role ? { id: 'u1', role } : undefined,
          headers,
        }),
      }),
    }) as unknown as ExecutionContext;

  const refusal = async (c: ExecutionContext) => {
    try {
      await guard.canActivate(c);
      return null;
    } catch (err) {
      return err as HttpException;
    }
  };

  beforeEach(() => {
    settings.minVendorAppVersion = null;
    settings.orderFlow = 'PAY_FIRST';
  });

  it('réglages par défaut : aucune application refusée, même sans en-tête', async () => {
    await expect(guard.canActivate(ctx('RESTAURATEUR'))).resolves.toBe(true);
  });

  it('client et administrateur ne sont jamais concernés', async () => {
    settings.orderFlow = 'ACCEPT_FIRST';
    settings.minVendorAppVersion = '9.9.9';
    await expect(guard.canActivate(ctx('CLIENT'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('ADMIN'))).resolves.toBe(true);
  });

  describe('seuil de version', () => {
    beforeEach(() => {
      settings.minVendorAppVersion = '1.0.6';
    });

    it('app vendeurs sous le seuil → 426 VENDOR_APP_UPDATE_REQUIRED', async () => {
      const err = await refusal(
        ctx('RESTAURATEUR', {
          'x-lilia-app': 'vendor',
          'x-lilia-app-version': '1.0.5+6',
        }),
      );
      expect(err?.getStatus()).toBe(426);
      expect(err?.getResponse()).toMatchObject({
        code: 'VENDOR_APP_UPDATE_REQUIRED',
      });
    });

    it('au seuil ou au-dessus → passe', async () => {
      for (const version of ['1.0.6', '1.0.6+7', '1.1.0']) {
        await expect(
          guard.canActivate(
            ctx('RESTAURATEUR', {
              'x-lilia-app': 'vendor',
              'x-lilia-app-version': version,
            }),
          ),
        ).resolves.toBe(true);
      }
    });

    it('version absente ou illisible → passe (comme MinAppVersionGuard)', async () => {
      await expect(
        guard.canActivate(ctx('RESTAURATEUR', { 'x-lilia-app': 'vendor' })),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(
          ctx('RESTAURATEUR', {
            'x-lilia-app': 'vendor',
            'x-lilia-app-version': 'beta',
          }),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('parcours ACCEPT_FIRST allumé', () => {
    beforeEach(() => {
      settings.orderFlow = 'ACCEPT_FIRST';
    });

    it('ancienne app sans aucun en-tête → 426 (elle ne saurait pas répondre à une demande)', async () => {
      const err = await refusal(ctx('RESTAURATEUR'));
      expect(err?.getStatus()).toBe(426);
      expect(
        String((err?.getResponse() as { message: string }).message),
      ).toMatch(/demande à accepter avant paiement/);
    });

    it('app qui annonce accept-first → passe', async () => {
      await expect(
        guard.canActivate(
          ctx('RESTAURATEUR', {
            'x-lilia-app': 'vendor',
            'x-lilia-app-version': '1.0.6',
            'x-lilia-order-flow': 'accept-first',
          }),
        ),
      ).resolves.toBe(true);
    });
  });
});
