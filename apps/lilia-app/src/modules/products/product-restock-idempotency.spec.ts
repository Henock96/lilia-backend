import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ProductCommandService } from './product-command.service';

/**
 * ADM-01 (audit Admin Flutter du 13/10/2026) — « Réapprovisionner +N » est
 * additif (`stockRestant + N`). L'app vendeurs rejouait automatiquement un
 * PATCH perdu en route : un geste commité puis rejoué ajoutait 2N, soit des
 * unités fantômes vendues puis refusées, puis remboursées.
 *
 * Le client porte désormais une `Idempotency-Key` par geste ; le serveur ne
 * compte un `RESTOCK` qu'une fois par clé. Sans clé (applications installées,
 * web), le comportement ne change pas.
 */
describe('ProductCommandService.updateStock — idempotence de RESTOCK', () => {
  const product = {
    id: 'p1',
    restaurantId: 'r1',
    stockPolicy: 'INVENTORY',
    stockMode: 'PERMANENT',
    stockQuotidien: 5,
    stockRestant: 5,
    restaurant: { owner: { firebaseUid: 'fb-owner' } },
  };

  function build(
    opts: {
      redis?: Record<string, jest.Mock> | null;
      redisUrl?: string | null;
    } = {},
  ) {
    const executeRaw = jest.fn().mockResolvedValue(1);
    const findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ ...product, stockRestant: 15 });
    const prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue(product),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...product, stockRestant: 15 }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'u1', role: 'RESTAURATEUR' }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ $executeRaw: executeRaw, product: { findUniqueOrThrow } }),
      ),
    };
    const redis =
      opts.redis === null
        ? undefined
        : (opts.redis ?? {
            set: jest.fn().mockResolvedValue('OK'),
            get: jest.fn().mockResolvedValue(null),
            del: jest.fn().mockResolvedValue(1),
          });
    const config = {
      get: jest.fn((k: string) =>
        k === 'REDIS_URL'
          ? opts.redisUrl === undefined
            ? 'redis://x'
            : opts.redisUrl
          : undefined,
      ),
    };
    const service = new ProductCommandService(
      prisma as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      { emit: jest.fn() } as never,
      {} as never,
      config as never,
      redis as never,
    );
    return { service, prisma, redis, executeRaw };
  }

  const restock = { action: 'RESTOCK' as const, units: 10 };

  it('première exécution d’une clé : incrémente une fois et mémorise le geste', async () => {
    const { service, redis, executeRaw } = build();

    const res = await service.updateStock(
      'p1',
      restock,
      'fb-owner',
      'geste-0001',
    );

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(redis!.set).toHaveBeenCalledWith(
      'stock:restock:u1:p1:geste-0001',
      'PENDING:10',
      'EX',
      120, // court : une clé restée PENDING après un crash ne bloque pas 24 h
      'NX',
    );
    expect(redis!.set).toHaveBeenLastCalledWith(
      'stock:restock:u1:p1:geste-0001',
      'DONE:10',
      'EX',
      24 * 60 * 60,
    );
    expect(res).toMatchObject({ data: { stockRestant: 15 } });
  });

  it('rejeu d’une clé déjà appliquée : n’incrémente pas, rend l’état courant', async () => {
    const { service, executeRaw, prisma } = build({
      redis: {
        set: jest.fn().mockResolvedValue(null),
        get: jest.fn().mockResolvedValue('DONE:10'),
        del: jest.fn(),
      },
    });

    const res = await service.updateStock(
      'p1',
      restock,
      'fb-owner',
      'geste-0001',
    );

    expect(executeRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res).toMatchObject({ replayed: true, data: { stockRestant: 15 } });
  });

  it('même clé en cours de traitement : 409, rien n’est écrit', async () => {
    const { service, executeRaw } = build({
      redis: {
        set: jest.fn().mockResolvedValue(null),
        get: jest.fn().mockResolvedValue('PENDING:10'),
        del: jest.fn(),
      },
    });

    await expect(
      service.updateStock('p1', restock, 'fb-owner', 'geste-0001'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('même clé réutilisée pour une autre quantité : 409, rien n’est écrit', async () => {
    const { service, executeRaw } = build({
      redis: {
        set: jest.fn().mockResolvedValue(null),
        get: jest.fn().mockResolvedValue('DONE:3'),
        del: jest.fn(),
      },
    });

    await expect(
      service.updateStock('p1', restock, 'fb-owner', 'geste-0001'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('échec de la transaction : la clé est libérée pour qu’un rejeu s’applique vraiment', async () => {
    const { service, redis, prisma } = build();
    prisma.$transaction.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.updateStock('p1', restock, 'fb-owner', 'geste-0001'),
    ).rejects.toThrow('db down');
    expect(redis!.del).toHaveBeenCalledWith('stock:restock:u1:p1:geste-0001');
  });

  it('Redis configuré mais en panne, avec une clé : 503 explicite, aucun incrément non protégé', async () => {
    const { service, executeRaw } = build({
      redis: {
        set: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
        get: jest.fn(),
        del: jest.fn(),
      },
    });

    await expect(
      service.updateStock('p1', restock, 'fb-owner', 'geste-0001'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('sans clé (applications installées, web) : comportement inchangé, Redis non sollicité', async () => {
    const { service, redis, executeRaw } = build();

    await service.updateStock('p1', restock, 'fb-owner');

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(redis!.set).not.toHaveBeenCalled();
  });

  it('Redis non configuré (dev, tests) : la clé est ignorée, le geste s’applique', async () => {
    const { service, executeRaw } = build({ redis: null, redisUrl: null });

    await service.updateStock('p1', restock, 'fb-owner', 'geste-0001');

    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('geste sans nombre d’unités (appel hors DTO) : 400, ni Redis ni écriture', async () => {
    const { service, redis, executeRaw } = build();

    await expect(
      service.updateStock(
        'p1',
        { action: 'RESTOCK' },
        'fb-owner',
        'geste-0001',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis!.set).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('clé malformée : 400, rien n’est écrit', async () => {
    const { service, executeRaw } = build();

    await expect(
      service.updateStock('p1', restock, 'fb-owner', 'x'.repeat(200)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
