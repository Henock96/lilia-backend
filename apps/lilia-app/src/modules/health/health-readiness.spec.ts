import { HttpStatus } from '@nestjs/common';

import { HealthController } from './health.controller';
import { FirebaseService } from '../firebase/firebase.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Ce que `/health/ready` doit rendre visible.
 *
 * ⚠️ La sonde testait PostgreSQL et rapportait Firebase, mais **ignorait
 * Redis** — alors qu'une panne Redis éteint trois contrôles d'un coup :
 * l'idempotence du checkout (double commande possible), le rate limiting
 * partagé, et les verrous de cron. Ces trois dégradations sont déjà
 * journalisées et remontées à Sentry ; elles n'apparaissaient nulle part dans
 * l'état de santé de l'instance, si bien que `status: ok` se lisait comme
 * « tout va bien » alors qu'il ne voulait dire que « la base répond ».
 *
 * Redis n'est **pas** bloquant : les replis existent et fonctionnent, sortir
 * l'instance du service la rendrait moins disponible sans rien réparer. Ce qui
 * manquait n'était pas un verdict, c'était l'information.
 */
describe('GET /health/ready', () => {
  function makeResponse() {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    return { res: { status } as never, status, json };
  }

  function controller(opts: {
    dbOk?: boolean;
    firebaseOk?: boolean;
    redis?: { ping: jest.Mock };
  }) {
    const prisma = {
      $queryRaw: jest.fn(() =>
        opts.dbOk === false
          ? Promise.reject(new Error('connexion refusée'))
          : Promise.resolve([{ 1: 1 }]),
      ),
    } as unknown as PrismaService;
    const firebase = {
      isReady: () => opts.firebaseOk !== false,
    } as unknown as FirebaseService;

    return new HealthController(
      firebase,
      prisma,
      (opts.redis ?? { ping: jest.fn().mockResolvedValue('PONG') }) as never,
    );
  }

  it('rapporte l’état de Redis', async () => {
    const ping = jest.fn().mockResolvedValue('PONG');
    const { res, json } = makeResponse();

    await controller({ redis: { ping } }).ready(res);

    expect(ping).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ redis: 'ok' }));
  });

  it('signale un Redis injoignable sans sortir l’instance du service', async () => {
    const ping = jest.fn().mockRejectedValue(new Error('timeout'));
    const { res, status, json } = makeResponse();

    await controller({ redis: { ping } }).ready(res);

    // Visible…
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ redis: 'error', status: 'degraded' }),
    );
    // …mais pas bloquant : les replis fonctionnent, retirer l'instance du
    // service la rendrait moins disponible sans rien réparer.
    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it('répond 503 quand la base est injoignable', async () => {
    const { res, status, json } = makeResponse();

    await controller({ dbOk: false }).ready(res);

    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', db: 'error' }),
    );
  });

  /**
   * ⚠️ Le point qui compte le plus dans cette sonde.
   *
   * Le client injecté est le profil « métier » : son seul plafond est
   * `commandTimeout`, 3 000 ms par défaut — et `.env.example` documente
   * `REDIS_COMMAND_TIMEOUT_MS` jusqu'à 30 000 ms comme le levier à poser sur
   * Render pendant un incident. Sans borne locale, `/health/ready` attendrait
   * donc jusqu'à trente secondes, et l'orchestrateur retirerait du service une
   * instance qui sert parfaitement — l'exact inverse de « Redis n'est pas
   * bloquant ».
   *
   * La borne est ici, dans la sonde, et non dans la configuration du client :
   * une sonde de disponibilité ne doit pas hériter de la patience d'un profil
   * réglé pour préserver une garantie métier.
   */
  it('répond sans attendre un Redis qui ne répond jamais', async () => {
    const jamais = jest.fn(() => new Promise(() => {}));
    const { res, status, json } = makeResponse();

    const debut = Date.now();
    await controller({ redis: { ping: jamais as never } }).ready(res);
    const duree = Date.now() - debut;

    expect(duree).toBeLessThan(2000);
    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ redis: 'error', status: 'degraded' }),
    );
  });

  it('reste 200 et « ok » quand tout répond', async () => {
    const { res, status, json } = makeResponse();

    await controller({}).ready(res);

    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', db: 'ok', firebase: 'ok' }),
    );
  });
});
