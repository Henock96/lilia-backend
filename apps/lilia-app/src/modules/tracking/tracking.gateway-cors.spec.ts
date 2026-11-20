import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';

/**
 * SEC-14 (audit du 18/11) — CORS de la gateway de tracking.
 *
 * Le décorateur `@WebSocketGateway` est évalué au chargement du module : c'est
 * là qu'un `ALLOWED_ORIGINS` manquant doit faire échouer le démarrage en
 * environnement déployé, au lieu d'ouvrir la gateway à toute origine.
 */
describe('TrackingGateway — CORS (SEC-14)', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  };

  const restore = (key: keyof typeof saved) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  };

  afterEach(() => {
    restore('NODE_ENV');
    restore('ALLOWED_ORIGINS');
  });

  /** Charge un module neuf et rend l'origine CORS que Nest appliquera. */
  const corsOrigin = (): unknown => {
    let origin: unknown;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { TrackingGateway } = require('./tracking.gateway');
      const options = Reflect.getMetadata(GATEWAY_OPTIONS, TrackingGateway) as {
        cors: { origin: unknown };
      };
      origin = options.cors.origin;
    });
    return origin;
  };

  it.each(['production', 'staging'])(
    'refuse de se charger en %s sans ALLOWED_ORIGINS',
    (env) => {
      process.env.NODE_ENV = env;
      delete process.env.ALLOWED_ORIGINS;

      expect(corsOrigin).toThrow(/ALLOWED_ORIGINS/);
    },
  );

  it('applique la liste blanche en production', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS =
      'https://www.liliafood.com, https://www.liliafood-admin.com';

    expect(corsOrigin()).toEqual([
      'https://www.liliafood.com',
      'https://www.liliafood-admin.com',
    ]);
  });

  it('reste ouverte en développement sans configuration', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOWED_ORIGINS;

    expect(corsOrigin()).toBe(true);
  });
});
