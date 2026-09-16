import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import {
  THROTTLER_LIMIT,
  THROTTLER_SKIP,
} from '@nestjs/throttler/dist/throttler.constants';

import { ParallelThrottlerGuard } from './parallel-throttler.guard';
import {
  SKIP_ALL_THROTTLERS,
  THROTTLER_LONG,
  THROTTLER_SHORT,
} from './throttler-names';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

/**
 * Throttling parallèle (P0-2).
 *
 * `ThrottlerGuard` parcourt ses limiteurs avec un `await` **dans la boucle**.
 * Nous en avons deux, et `@nest-lab/throttler-storage-redis` fait un `EVAL` par
 * limiteur : deux allers-retours en série, ~545 ms sur **chaque** requête avec
 * un Redis à ~271 ms.
 *
 * Ces tests portent sur le **comportement**, pas sur l'implémentation : les deux
 * limites s'appliquent toujours, les décorateurs sont toujours lus. Si une montée
 * de version de `@nestjs/throttler` change ce contrat, ils échouent — c'est leur
 * raison d'être, la classe recopiant la résolution d'options de la v6.4.0.
 */
describe('ParallelThrottlerGuard', () => {
  const throttlers = [
    { name: THROTTLER_SHORT, ttl: 1000, limit: 10 },
    { name: THROTTLER_LONG, ttl: 60000, limit: 100 },
  ];

  function makeContext(): ExecutionContext {
    const res = { header: jest.fn() };
    const req = { ip: '10.0.0.1', headers: {} };
    return {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
  }

  /**
   * Construit le guard avec un stockage instrumenté.
   *
   * `overrides` simule les décorateurs `@Throttle` / `@SkipThrottle` : le
   * Reflector rend une valeur pour la clé `<CONSTANTE><nomDuLimiteur>`, ce qui
   * est exactement le mécanisme que la bibliothèque utilise.
   */
  async function buildGuard(options: {
    /** Limiteurs ayant atteint leur plafond. */
    blocked?: string[];
    /** Limiteurs dont le stockage est en panne. */
    failing?: string[];
    overrides?: Record<string, unknown>;
    /** Latence simulée d'un aller-retour Redis. */
    latencyMs?: number;
  }) {
    const {
      blocked = [],
      failing = [],
      overrides = {},
      latencyMs = 0,
    } = options;

    const timeline: { name: string; startedAt: number; endedAt: number }[] = [];

    const storage = {
      increment: jest.fn(
        async (
          _key: string,
          _ttl: number,
          limit: number,
          _blockDuration: number,
          name: string,
        ) => {
          const startedAt = Date.now();
          if (latencyMs) {
            await new Promise((resolve) => setTimeout(resolve, latencyMs));
          }
          timeline.push({ name, startedAt, endedAt: Date.now() });

          if (failing.includes(name)) {
            throw new Error(`Redis indisponible (${name})`);
          }
          const isBlocked = blocked.includes(name);
          return {
            totalHits: isBlocked ? limit + 1 : 1,
            timeToExpire: 1,
            isBlocked,
            timeToBlockExpire: 1,
          };
        },
      ),
    };

    const reflector = {
      getAllAndOverride: jest.fn((key: string) => overrides[key]),
    } as unknown as Reflector;

    const guard = new ParallelThrottlerGuard(
      { throttlers } as never,
      storage as never,
      reflector,
    );
    await guard.onModuleInit();
    return { guard, storage, timeline };
  }

  it('applique la limite « short » (10/s)', async () => {
    const { guard } = await buildGuard({ blocked: [THROTTLER_SHORT] });
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('applique la limite « long » (100/min)', async () => {
    const { guard } = await buildGuard({ blocked: [THROTTLER_LONG] });
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('laisse passer quand aucune limite n’est atteinte, en consultant les DEUX', async () => {
    const { guard, storage } = await buildGuard({});

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(storage.increment).toHaveBeenCalledTimes(2);
    const consulted = storage.increment.mock.calls.map((call) => call[4]);
    expect(consulted).toEqual(
      expect.arrayContaining([THROTTLER_SHORT, THROTTLER_LONG]),
    );
  });

  it('interroge Redis pour les deux limiteurs EN PARALLÈLE', async () => {
    // Le cœur du correctif. En série, le second appel commence après la fin du
    // premier ; en parallèle, leurs intervalles se chevauchent.
    const { guard, timeline } = await buildGuard({ latencyMs: 40 });

    await guard.canActivate(makeContext());

    expect(timeline).toHaveLength(2);
    const [first, second] = timeline;
    const overlap =
      Math.min(first.endedAt, second.endedAt) -
      Math.max(first.startedAt, second.startedAt);
    expect(overlap).toBeGreaterThan(0);
  });

  it('honore @SkipThrottle(SKIP_ALL_THROTTLERS) — les sondes de santé restent exemptées', async () => {
    const { guard, storage } = await buildGuard({
      overrides: {
        [THROTTLER_SKIP + THROTTLER_SHORT]:
          SKIP_ALL_THROTTLERS[THROTTLER_SHORT],
        [THROTTLER_SKIP + THROTTLER_LONG]: SKIP_ALL_THROTTLERS[THROTTLER_LONG],
      },
    });

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(storage.increment).not.toHaveBeenCalled();
  });

  it('honore @Throttle : une limite de route remplace celle du module', async () => {
    // Les 17 décorateurs du dépôt nomment explicitement les deux limiteurs
    // (`@Throttle({ short: …, long: … })`). Aucun n'a été touché ; ils doivent
    // continuer d'être lus, limiteur par limiteur.
    const { guard, storage } = await buildGuard({
      overrides: { [THROTTLER_LIMIT + THROTTLER_SHORT]: 1 },
    });

    await guard.canActivate(makeContext());

    const shortCall = storage.increment.mock.calls.find(
      (call) => call[4] === THROTTLER_SHORT,
    );
    const longCall = storage.increment.mock.calls.find(
      (call) => call[4] === THROTTLER_LONG,
    );
    expect(shortCall?.[2]).toBe(1); // limite de la route
    expect(longCall?.[2]).toBe(100); // limite du module, intacte
  });

  it('rend une erreur déterministe quand les deux limites sont atteintes', async () => {
    // `onModuleInit` trie par `ttl` croissant : `short` d'abord. C'est déjà
    // l'ordre que produisait la boucle séquentielle — le message ne change pas.
    const { guard } = await buildGuard({
      blocked: [THROTTLER_SHORT, THROTTLER_LONG],
    });

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('⚠️ différence assumée : un rejet de « short » incrémente quand même « long »', async () => {
    // En série, l'exception de `short` interrompait la boucle et `long`
    // n'était jamais consulté. En parallèle, les deux compteurs avancent.
    // C'est PLUS strict, jamais plus permissif : un client dans les clous ne
    // voit aucune différence, un client qui dépasse est freiné un peu plus tôt.
    const { guard, storage } = await buildGuard({ blocked: [THROTTLER_SHORT] });

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    expect(storage.increment).toHaveBeenCalledTimes(2);
  });

  it('panne Redis : la requête passe et une alerte part, au lieu d’un 500 pour tout le monde', async () => {
    // Sans ce rattrapage, l'erreur du stockage remonte jusqu'à `canActivate` :
    // une panne Redis fait répondre 500 à *toutes* les requêtes, publiques
    // comprises. Le rate limiting est une protection, pas une garantie de
    // correction — rendre la plateforme inutilisable pour la préserver serait
    // une panne plus grande que celle qu'on subit. Même arbitrage que celui
    // déjà assumé pour l'idempotence du checkout.
    const Sentry = jest.requireMock('@sentry/nestjs') as {
      captureException: jest.Mock;
    };
    Sentry.captureException.mockClear();

    const { guard } = await buildGuard({
      failing: [THROTTLER_SHORT, THROTTLER_LONG],
    });

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { feature: 'rate-limiting', degraded: 'true' },
    });
  });

  it('une panne d’un seul limiteur ne désarme pas l’autre', async () => {
    const { guard } = await buildGuard({
      failing: [THROTTLER_LONG],
      blocked: [THROTTLER_SHORT],
    });

    // `short` bloque toujours, malgré la panne de `long`.
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });
});
