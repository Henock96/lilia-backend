import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ProductCommandService } from './product-command.service';

/**
 * ADM-01 (audit Admin Flutter du 13/10/2026) — « Réapprovisionner +N » est
 * additif (`stockRestant + N`). L'app vendeurs rejouait automatiquement un
 * PATCH perdu en route : un geste commité puis rejoué ajoutait 2N, soit des
 * unités fantômes vendues puis refusées, puis remboursées.
 *
 * Le client porte une `Idempotency-Key` par geste ; le serveur ne compte un
 * `RESTOCK` qu'une fois par clé. Durcissement lot 4 : la clé est un reçu
 * `IdempotencyReceipt` écrit dans la transaction du geste (plus de Redis, donc
 * plus de 503 quand Upstash tombe). Sans clé (applications installées, web),
 * le comportement ne change pas. La course réelle est rejouée sur PostgreSQL
 * par `test/integration/stock-restock-idempotency.int-spec.ts`.
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

  function build(opts: { prior?: { fingerprint: string } | null } = {}) {
    const executeRaw = jest.fn().mockResolvedValue(1);
    const receiptCreate = jest.fn().mockResolvedValue({});
    const findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ ...product, stockRestant: 15 });
    const receiptFindUnique = jest.fn().mockResolvedValue(opts.prior ?? null);
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
      idempotencyReceipt: { findUnique: receiptFindUnique },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          $executeRaw: executeRaw,
          product: { findUniqueOrThrow },
          idempotencyReceipt: { create: receiptCreate },
        }),
      ),
    };
    const service = new ProductCommandService(
      prisma as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      { emit: jest.fn() } as never,
      {} as never,
    );
    return { service, prisma, executeRaw, receiptCreate, receiptFindUnique };
  }

  const restock = { action: 'RESTOCK' as const, units: 10 };

  it('première exécution d’une clé : écrit le reçu AVANT l’incrément, dans la transaction', async () => {
    const { service, executeRaw, receiptCreate } = build();

    const res = await service.updateStock(
      'p1',
      restock,
      'fb-owner',
      'geste-0001',
    );

    expect(receiptCreate).toHaveBeenCalledWith({
      data: {
        scope: 'stock.restock',
        ownerId: 'u1',
        key: 'geste-0001',
        fingerprint: 'p1:10',
      },
    });
    expect(receiptCreate.mock.invocationCallOrder[0]).toBeLessThan(
      executeRaw.mock.invocationCallOrder[0],
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ data: { stockRestant: 15 } });
  });

  it('rejeu d’une clé déjà appliquée : n’incrémente pas, rend l’état courant', async () => {
    const { service, executeRaw, prisma } = build({
      prior: { fingerprint: 'p1:10' },
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

  it('même clé réutilisée pour une autre quantité : 409, rien n’est écrit', async () => {
    const { service, executeRaw } = build({ prior: { fingerprint: 'p1:3' } });

    await expect(
      service.updateStock('p1', restock, 'fb-owner', 'geste-0001'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('requête jumelle qui perd la course (P2002) : rejouée, pas une erreur', async () => {
    const { service, prisma, receiptFindUnique } = build();
    receiptFindUnique
      .mockResolvedValueOnce(null) // avant la transaction : rien encore
      .mockResolvedValueOnce({ fingerprint: 'p1:10' }); // après la collision
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const res = await service.updateStock(
      'p1',
      restock,
      'fb-owner',
      'geste-0001',
    );

    expect(res).toMatchObject({ replayed: true });
  });

  it('P2002 étranger au reçu (aucun reçu relu) : l’erreur réelle remonte, pas un faux 409', async () => {
    const { service, prisma } = build();
    const foreign = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on AuditLog',
      { code: 'P2002', clientVersion: 'test' },
    );
    prisma.$transaction.mockRejectedValueOnce(foreign);

    await expect(
      service.updateStock('p1', restock, 'fb-owner', 'geste-0001'),
    ).rejects.toBe(foreign);
  });

  it('échec de la transaction sans collision : l’erreur remonte, aucun reçu ne survit', async () => {
    const { service, prisma } = build();
    prisma.$transaction.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.updateStock('p1', restock, 'fb-owner', 'geste-0001'),
    ).rejects.toThrow('db down');
  });

  it('sans clé (applications installées, web) : comportement inchangé, aucun reçu', async () => {
    const { service, executeRaw, receiptCreate, receiptFindUnique } = build();

    await service.updateStock('p1', restock, 'fb-owner');

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(receiptCreate).not.toHaveBeenCalled();
    expect(receiptFindUnique).not.toHaveBeenCalled();
  });

  it('geste sans nombre d’unités (appel hors DTO) : 400, ni reçu ni écriture', async () => {
    const { service, receiptCreate, executeRaw } = build();

    await expect(
      service.updateStock(
        'p1',
        { action: 'RESTOCK' },
        'fb-owner',
        'geste-0001',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(receiptCreate).not.toHaveBeenCalled();
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
