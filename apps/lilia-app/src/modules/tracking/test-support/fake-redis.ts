/**
 * Client Redis factice exposant l'API de pipeline d'ioredis.
 *
 * `TrackingService` empile désormais ses écritures de position sur un
 * `pipeline()` au lieu de les enchaîner. Les tests doivent donc pouvoir vérifier
 * deux choses que trois `jest.fn()` séparés ne montraient pas :
 *
 *  1. que les commandes sont bien **toutes sur le même pipeline** (un seul
 *     aller-retour) ;
 *  2. que le résultat du verrou est lu **au bon indice** — c'est la seule
 *     valeur de retour dont dépend la persistance en base.
 *
 * Les espions `geoadd` / `setex` / `set` restent exposés au niveau du client
 * pour que les assertions existantes sur les arguments et les TTL continuent de
 * porter, inchangées.
 */
export interface FakeRedis {
  geoadd: jest.Mock;
  setex: jest.Mock;
  set: jest.Mock;
  pipeline: jest.Mock;
  /** Nombre de pipelines réellement exécutés — c'est le compteur d'allers-retours. */
  execCount: () => number;
}

interface FakeRedisOptions {
  /** Valeur rendue par `SET … NX` : `'OK'` = verrou obtenu, `null` = déjà pris. */
  setResult?: 'OK' | null;
  /** Erreur à placer sur la n-ième commande du pipeline, pour tester la propagation. */
  failAt?: { index: number; error: Error };
}

export function fakeRedis(options: FakeRedisOptions = {}): FakeRedis {
  const { setResult = 'OK', failAt } = options;

  const geoadd = jest.fn();
  const setex = jest.fn();
  const set = jest.fn();
  let execs = 0;

  const pipeline = jest.fn(() => {
    const results: [Error | null, unknown][] = [];

    const builder = {
      geoadd: (...args: unknown[]) => {
        geoadd(...args);
        results.push([null, 1]);
        return builder;
      },
      setex: (...args: unknown[]) => {
        setex(...args);
        results.push([null, 'OK']);
        return builder;
      },
      set: (...args: unknown[]) => {
        set(...args);
        results.push([null, setResult]);
        return builder;
      },
      exec: () => {
        execs += 1;
        if (failAt && results[failAt.index]) {
          results[failAt.index] = [failAt.error, null];
        }
        return Promise.resolve(results);
      },
    };

    return builder;
  });

  return { geoadd, setex, set, pipeline, execCount: () => execs };
}
