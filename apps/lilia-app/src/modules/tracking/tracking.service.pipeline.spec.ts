import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { TrackingService } from './tracking.service';
import { PrismaService } from '../../prisma/prisma.service';
import { fakeRedis } from './test-support/fake-redis';

/**
 * Mise en pipeline des écritures de position (P0-2).
 *
 * `updatePosition` enchaînait trois `await` — `GEOADD`, `SETEX`, `SET NX` —
 * alors qu'aucune des trois ne dépend du résultat de la précédente. Avec un
 * Redis mesuré à ~271 ms de l'instance, cela coûtait trois temps de trajet sur
 * un message émis **toutes les 5 secondes par livreur en course**.
 *
 * Ces tests fixent ce qui doit rester vrai après la mise en pipeline : le
 * nombre d'allers-retours, mais surtout le fait que **rien d'autre ne change** —
 * mêmes commandes, mêmes TTL, même sémantique de verrou, mêmes erreurs.
 */
describe('TrackingService — écritures de position en pipeline', () => {
  let service: TrackingService;
  let prisma: { delivery: { findUnique: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      delivery: {
        findUnique: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // Journal d'audit : conclusion d'une course par un ADMIN (F-06).
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
        // Obligations durables écrites dans la transaction `LIVRER` (lot 4).
        {
          provide: OutboxService,
          useValue: { enqueueInTransaction: jest.fn() },
        },
        TrackingService,
        {
          provide: PrismaService,
          useValue: { ...prisma, deliveryLocation: { create: jest.fn() } },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(TrackingService);
  });

  const position = {
    orderId: 'o1',
    driverId: 'd1',
    lat: -4.2634,
    lng: 15.2429,
    accuracy: 8,
  };

  it('envoie les commandes en un seul aller-retour', async () => {
    const redis = fakeRedis();
    (service as any).redis = redis;

    await service.updatePosition(position);

    // C'est l'objet même du correctif : un `exec`, pas plusieurs `await`.
    expect(redis.execCount()).toBe(1);
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it("⚠️ n'écrit AUCUNE coordonnée sans expiration", async () => {
    // `GEOADD driver_positions` était écrit toutes les 5 s par livreur en
    // course — et **jamais lu** : aucun `GEOPOS`, `GEORADIUS` ni `GEOSEARCH`
    // n'existe dans le dépôt. Un ensemble trié n'a pas de TTL par membre et
    // rien ne l'émondait : les coordonnées d'un livreur y survivaient à sa
    // déconnexion, à sa sortie de la plateforme et à la suppression de son
    // compte (`UserDeletionService`), indexées par son UID Firebase.
    //
    // Une structure qu'on écrit sans jamais la lire n'est pas une fondation
    // pour plus tard : c'est une rétention de données de déplacement que rien
    // ne borne. Le jour où « le livreur le plus proche » sera construit, le
    // `GEOADD` reviendra — avec son lecteur et son émondage.
    //
    // Ce qui reste, `delivery:{orderId}`, porte un TTL de 5 minutes.
    const redis = fakeRedis();
    (service as any).redis = redis;

    await service.updatePosition(position);

    expect(redis.geoadd).not.toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalledWith(
      'delivery:o1',
      300, // TTL position inchangé
      expect.any(String),
    );
    expect(redis.set).toHaveBeenCalledWith(
      'persist_lock:o1',
      '1',
      'EX',
      60, // intervalle de persistance inchangé
      'NX',
    );
  });

  it('lit le verrou au bon indice : verrou obtenu ⇒ la position est persistée', async () => {
    const redis = fakeRedis({ setResult: 'OK' });
    (service as any).redis = redis;

    await service.updatePosition(position);
    // `persistPosition` est volontairement en fire-and-forget : on laisse la
    // micro-tâche s'exécuter avant d'observer.
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.delivery.findUnique).toHaveBeenCalledWith({
      where: { orderId: 'o1' },
      select: { id: true },
    });
  });

  it('verrou déjà pris ⇒ aucune écriture en base', async () => {
    const redis = fakeRedis({ setResult: null });
    (service as any).redis = redis;

    await service.updatePosition(position);
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.delivery.findUnique).not.toHaveBeenCalled();
  });

  it('une erreur Redis reste une erreur — elle ne devient pas un succès silencieux', async () => {
    // `pipeline().exec()` se résout même quand une commande échoue : l'erreur
    // est rendue dans le couple `[erreur, résultat]`. Sans contrôle explicite,
    // la mise en pipeline aurait avalé la panne — et pire, aurait lu le verrou
    // comme « déjà pris », si bien qu'aucune position n'aurait plus jamais
    // atteint la base.
    const boom = new Error('READONLY You can’t write against a replica');
    const redis = fakeRedis({ failAt: { index: 0, error: boom } });
    (service as any).redis = redis;

    await expect(service.updatePosition(position)).rejects.toThrow(boom);
    expect(prisma.delivery.findUnique).not.toHaveBeenCalled();
  });

  it('le repli HTTP (cacheLivePosition) tient en un aller-retour lui aussi', async () => {
    const redis = fakeRedis();
    (service as any).redis = redis;

    await service.cacheLivePosition(position);

    expect(redis.execCount()).toBe(1);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    // Le repli HTTP ne pose PAS de verrou de persistance : c'est
    // `DeliveriesService.updateLocation` qui écrit déjà en base de son côté.
    expect(redis.set).not.toHaveBeenCalled();
  });
});
