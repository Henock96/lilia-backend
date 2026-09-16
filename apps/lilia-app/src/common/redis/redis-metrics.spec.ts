import {
  currentRedisStats,
  instrumentRedisClient,
  runWithRedisMetrics,
} from './redis-metrics';

/**
 * Comptage des appels Redis par requête.
 *
 * L'enjeu de ces tests n'est pas seulement que le compteur compte : c'est que
 * **rien d'autre ne soit retenu**. L'intégration Redis native de Sentry n'a pas
 * été activée précisément parce que son sérialiseur envoie les arguments des
 * commandes — donc, chez nous, des UID Firebase (`GET user:fbuid:…`), des clés
 * d'idempotence (`SET idempotency:…`) et la position GPS des livreurs
 * (`GEOADD driver_positions <lng> <lat> <id>`).
 *
 * Le dernier test de ce fichier est celui qui compte : il fait passer un secret
 * en argument et exige qu'on ne le retrouve nulle part.
 */
describe('redis-metrics', () => {
  /** Faux client exposant `sendCommand`, comme ioredis. */
  function fakeClient(behaviour?: { reject?: Error; sync?: boolean }) {
    const calls: unknown[][] = [];
    const client = {
      sendCommand(...args: unknown[]) {
        calls.push(args);
        if (behaviour?.sync) return 'immédiat';
        const promise = behaviour?.reject
          ? Promise.reject(behaviour.reject)
          : Promise.resolve('OK');
        // ioredis rend un objet `Command` porteur d'une promesse, pas la
        // promesse elle-même.
        return { promise };
      },
    };
    return { client, calls };
  }

  const command = (name: string, ...args: unknown[]) => ({ name, args });

  it('compte les commandes et cumule leur durée', async () => {
    const { client } = fakeClient();
    instrumentRedisClient(client);

    const stats = await runWithRedisMetrics(async (s) => {
      await (client.sendCommand(command('get', 'k1')) as any).promise;
      await (client.sendCommand(command('set', 'k2', 'v')) as any).promise;
      await (client.sendCommand(command('get', 'k3')) as any).promise;
      return s;
    });

    expect(stats.calls).toBe(3);
    expect(stats.byCommand).toEqual({ get: 2, set: 1 });
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('compte aussi les commandes qui échouent', async () => {
    const { client } = fakeClient({ reject: new Error('timeout') });
    instrumentRedisClient(client);

    const stats = await runWithRedisMetrics(async (s) => {
      await expect(
        (client.sendCommand(command('eval', 'script')) as any).promise,
      ).rejects.toThrow('timeout');
      return s;
    });

    // Une commande qui expire est précisément celle qu'on veut voir dans la
    // mesure : l'ignorer ferait disparaître des relevés le cas qui coûte cher.
    expect(stats.calls).toBe(1);
    expect(stats.byCommand).toEqual({ eval: 1 });
  });

  it('ne fait rien hors contexte de requête (crons, listeners, WebSocket)', () => {
    const { client, calls } = fakeClient({ sync: true });
    instrumentRedisClient(client);

    expect(currentRedisStats()).toBeUndefined();
    const result = client.sendCommand(command('get', 'k'));

    expect(result).toBe('immédiat');
    expect(calls).toHaveLength(1);
  });

  it('est idempotent : instrumenter deux fois ne double pas les compteurs', async () => {
    const { client } = fakeClient();
    instrumentRedisClient(client);
    instrumentRedisClient(client);

    const stats = await runWithRedisMetrics(async (s) => {
      await (client.sendCommand(command('get', 'k')) as any).promise;
      return s;
    });

    expect(stats.calls).toBe(1);
  });

  it('préserve le `this` de l’appelant (patch de prototype)', async () => {
    // Le patch doit pouvoir s'appliquer à `Redis.prototype` : si `original`
    // était liée à la cible, toutes les commandes de tous les clients
    // partiraient sur le prototype au lieu de leur propre connexion.
    const prototype = {
      sendCommand(this: { id?: string }) {
        return { promise: Promise.resolve(this.id) };
      },
    };
    instrumentRedisClient(prototype);

    const instance = Object.create(prototype) as {
      id: string;
      sendCommand: (c: unknown) => { promise: Promise<unknown> };
    };
    instance.id = 'client-A';

    const value = await runWithRedisMetrics(
      () => instance.sendCommand(command('ping')).promise,
    );

    expect(value).toBe('client-A');
  });

  it('ne retient AUCUN argument de commande — ni clé, ni valeur, ni identifiant', async () => {
    const { client } = fakeClient();
    instrumentRedisClient(client);

    const secrets = [
      'user:fbuid:AbCdEf123456UidFirebase',
      'idempotency:AbCdEf123456UidFirebase:9f3c-clé-du-client',
      'driver_positions',
      '15.2429',
      '-4.2634',
      'driver-42',
    ];

    const stats = await runWithRedisMetrics(async (s) => {
      await (client.sendCommand(command('get', secrets[0])) as any).promise;
      await (client.sendCommand(command('set', secrets[1], 'v')) as any)
        .promise;
      await (
        client.sendCommand(
          command('geoadd', secrets[2], secrets[3], secrets[4], secrets[5]),
        ) as any
      ).promise;
      return s;
    });

    // Tout ce que la mesure connaît, sérialisé : aucun secret ne doit y figurer.
    const everythingWeKeep = JSON.stringify(stats);
    for (const secret of secrets) {
      expect(everythingWeKeep).not.toContain(secret);
    }
    expect(stats.byCommand).toEqual({ get: 1, set: 1, geoadd: 1 });
  });
});
