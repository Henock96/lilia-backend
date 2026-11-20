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

  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.ALLOWED_ORIGINS === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = saved.ALLOWED_ORIGINS;
    }
  });

  const loadGateway = () =>
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./tracking.gateway');
    });

  it('refuse de se charger en production sans ALLOWED_ORIGINS', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOWED_ORIGINS;

    expect(loadGateway).toThrow(/ALLOWED_ORIGINS/);
  });

  it('se charge en production avec une liste blanche', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://www.liliafood.com';

    expect(loadGateway).not.toThrow();
  });

  it('reste ouverte en développement sans configuration', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOWED_ORIGINS;

    expect(loadGateway).not.toThrow();
  });
});
