import { ConfigService } from '@nestjs/config';

import { envValidationSchema } from '../config/env.validation';
import {
  buildPoolConfig,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MIN,
  POOL_KEEPALIVE_INITIAL_DELAY_MS,
  POOL_MAX_LIFETIME_SECONDS,
} from './pool-config';

const DATABASE_URL = 'postgresql://user:password@localhost:5432/lilia_db';

/** Reproduit `ConfigModule` : le schéma valide et convertit, puis on lit. */
function configFrom(env: Record<string, string>): ConfigService {
  const { value, error } = envValidationSchema.validate(
    {
      DATABASE_URL,
      FIREBASE_PROJECT_ID: 'p',
      FIREBASE_CLIENT_EMAIL: 'a@b.co',
      FIREBASE_PRIVATE_KEY: 'k',
      ...env,
    },
    { allowUnknown: true },
  );
  if (error) throw error;
  return new ConfigService(value);
}

describe('buildPoolConfig', () => {
  it('garde des connexions ouvertes par défaut, au lieu des 10 s de pg-pool', () => {
    const pool = buildPoolConfig(configFrom({}));

    expect(pool.connectionString).toBe(DATABASE_URL);
    expect(pool.min).toBe(DEFAULT_POOL_MIN);
    expect(pool.min).toBeGreaterThan(0);
    expect(pool.idleTimeoutMillis).toBe(DEFAULT_POOL_IDLE_TIMEOUT_MS);
    expect(pool.idleTimeoutMillis).toBeGreaterThan(60_000);
  });

  it('sonde et renouvelle les connexions qu’il garde longtemps', () => {
    const pool = buildPoolConfig(configFrom({}));

    // Une connexion gardée sous `min` peut rester inactive des heures : sans
    // sonde ni durée de vie, une coupure silencieuse la laisserait morte dans
    // le pool, pour la requête suivante.
    expect(pool.keepAlive).toBe(true);
    expect(pool.keepAliveInitialDelayMillis).toBe(
      POOL_KEEPALIVE_INITIAL_DELAY_MS,
    );
    expect(pool.maxLifetimeSeconds).toBe(POOL_MAX_LIFETIME_SECONDS);
    expect(pool.maxLifetimeSeconds).toBeGreaterThan(0);
  });

  it('traite une variable vide comme non posée', () => {
    const pool = buildPoolConfig(
      configFrom({ DATABASE_POOL_MIN: '', DATABASE_POOL_IDLE_TIMEOUT_MS: '' }),
    );

    expect(pool.min).toBe(DEFAULT_POOL_MIN);
    expect(pool.idleTimeoutMillis).toBe(DEFAULT_POOL_IDLE_TIMEOUT_MS);
  });

  it('applique les valeurs posées, converties en nombres', () => {
    const pool = buildPoolConfig(
      configFrom({
        DATABASE_POOL_MIN: '0',
        DATABASE_POOL_IDLE_TIMEOUT_MS: '30000',
      }),
    );

    expect(pool.min).toBe(0);
    expect(pool.idleTimeoutMillis).toBe(30_000);
  });

  it.each([
    ['DATABASE_POOL_MIN', '11'],
    ['DATABASE_POOL_MIN', '-1'],
    ['DATABASE_POOL_IDLE_TIMEOUT_MS', '500'],
    ['DATABASE_POOL_IDLE_TIMEOUT_MS', 'abc'],
  ])('refuse %s=%s au démarrage', (key, raw) => {
    expect(() => configFrom({ [key]: raw })).toThrow(key);
  });
});
