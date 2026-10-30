import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { LedgerPostingMode } from './ledger-accounts';
import {
  LedgerPostingError,
  Posting,
  PostingLine,
  reversalPosting,
} from './ledger-postings';

export type PostOutcome = 'POSTED' | 'DUPLICATE';

/** Violation d'unicité Prisma (clé d'idempotence déjà écrite). */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * Écriture et lecture du grand livre (lot 2, 30/10/2026).
 *
 * ## Atomicité
 *
 * Une transaction du grand livre (en-tête + lignes) s'écrit dans UNE
 * transaction PostgreSQL. L'équilibre est vérifié par la base au `COMMIT`
 * (trigger différé) : une transaction déséquilibrée n'existe jamais, même
 * écrite par un autre chemin que ce service.
 *
 * ## Idempotence
 *
 * `sourceEventKey` est unique. Deux écritures concurrentes du même fait : la
 * seconde lève une violation d'unicité, que l'on traduit en `DUPLICATE`. Le
 * fait n'est jamais compté deux fois.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async post(
    posting: Posting,
    mode: LedgerPostingMode = 'LIVE',
  ): Promise<PostOutcome> {
    try {
      await this.prisma.$transaction((tx) =>
        this.postInTransaction(tx, posting, mode),
      );
      return 'POSTED';
    } catch (err) {
      if (isUniqueViolation(err)) return 'DUPLICATE';
      throw err;
    }
  }

  /**
   * Écrit dans une transaction ouverte par l'appelant — pour un mouvement
   * métier qui veut son écriture comptable dans SA transaction. Une violation
   * d'unicité y annule toute la transaction : à l'appelant d'en décider.
   */
  async postInTransaction(
    tx: Prisma.TransactionClient,
    posting: Posting,
    mode: LedgerPostingMode,
    extra: { reversesTxId?: string; actorUserId?: string } = {},
  ): Promise<string> {
    const created = await tx.ledgerTransaction.create({
      data: {
        kind: posting.kind,
        sourceType: posting.sourceType,
        sourceId: posting.sourceId,
        sourceEventKey: posting.sourceEventKey,
        origin: posting.origin,
        postingMode: mode,
        occurredAt: posting.occurredAt,
        evidenceRef: posting.evidenceRef ?? null,
        note: posting.note ?? null,
        reversesTxId: extra.reversesTxId ?? null,
        actorUserId: extra.actorUserId ?? null,
        entries: {
          create: posting.lines.map((l) => ({
            account: l.account,
            subjectType: l.subjectType ?? null,
            subjectId: l.subjectId ?? null,
            amountXaf: l.amountXaf,
          })),
        },
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Fait qui ne peut pas être écrit sans inventer : consigné pour arbitrage.
   * Rejoué à chaque passage tant qu'il n'est pas résolu (date mise à jour).
   */
  async recordException(
    err: LedgerPostingError,
    source: { sourceType: string; sourceId: string },
  ): Promise<void> {
    await this.prisma.ledgerPostingException.upsert({
      where: { sourceEventKey: err.sourceEventKey },
      create: {
        sourceEventKey: err.sourceEventKey,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        reason: err.reason,
        detail: err.message,
      },
      update: {
        lastSeenAt: new Date(),
        reason: err.reason,
        detail: err.message,
      },
    });
  }

  /**
   * Contre-passation : corrige sans réécrire. Une seule par transaction
   * (unicité `reversesTxId`).
   */
  async reverse(input: {
    txId: string;
    reason: string;
    actorUserId: string;
  }): Promise<{ id: string; outcome: PostOutcome }> {
    const original = await this.prisma.ledgerTransaction.findUnique({
      where: { id: input.txId },
      include: { entries: true },
    });
    if (!original) throw new NotFoundException('Transaction introuvable.');
    const posting = reversalPosting({
      original: {
        id: original.id,
        sourceEventKey: original.sourceEventKey,
        lines: original.entries.map(
          (e): PostingLine => ({
            account: e.account as PostingLine['account'],
            subjectType: (e.subjectType ??
              undefined) as PostingLine['subjectType'],
            subjectId: e.subjectId ?? undefined,
            amountXaf: e.amountXaf,
          }),
        ),
      },
      reason: input.reason,
      at: new Date(),
      origin: 'ADMIN',
    });
    try {
      const id = await this.prisma.$transaction((tx) =>
        this.postInTransaction(tx, posting, 'LIVE', {
          reversesTxId: original.id,
          actorUserId: input.actorUserId,
        }),
      );
      return { id, outcome: 'POSTED' };
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { id: original.id, outcome: 'DUPLICATE' };
      }
      throw err;
    }
  }

  /** Soldes par compte (et sous-compte), au signe du grand livre. */
  async balances(
    filter: { account?: string; subjectId?: string } = {},
  ): Promise<
    { account: string; subjectId: string | null; balanceXaf: number }[]
  > {
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['account', 'subjectId'],
      where: {
        ...(filter.account ? { account: filter.account } : {}),
        ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
      },
      _sum: { amountXaf: true },
    });
    return rows
      .map((r) => ({
        account: r.account,
        subjectId: r.subjectId,
        balanceXaf: r._sum.amountXaf ?? 0,
      }))
      .filter((r) => r.balanceXaf !== 0);
  }

  listExceptions(status: 'OPEN' | 'RESOLVED' = 'OPEN') {
    return this.prisma.ledgerPostingException.findMany({
      where: { resolvedAt: status === 'OPEN' ? null : { not: null } },
      orderBy: { firstSeenAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Arbitrage d'une exception : consigné, jamais une écriture forcée. Si le
   * fait source est corrigé, le posteur l'écrira au passage suivant.
   */
  async resolveException(input: {
    id: string;
    note: string;
    actorUserId: string;
  }) {
    const res = await this.prisma.ledgerPostingException.updateMany({
      where: { id: input.id, resolvedAt: null },
      data: {
        resolvedAt: new Date(),
        resolvedBy: input.actorUserId,
        resolutionNote: input.note.trim(),
      },
    });
    if (res.count === 0) {
      const exists = await this.prisma.ledgerPostingException.count({
        where: { id: input.id },
      });
      if (!exists) throw new NotFoundException('Exception introuvable.');
      throw new ConflictException('Cette exception est déjà arbitrée.');
    }
    return this.prisma.ledgerPostingException.findUniqueOrThrow({
      where: { id: input.id },
    });
  }

  /**
   * Exclut une commande (de test) du grand livre. Refusé si elle y est déjà
   * écrite : le grand livre ne s'efface pas, il se contre-passe d'abord.
   */
  async excludeOrder(input: {
    orderId: string;
    reason: string;
    actorUserId: string;
  }) {
    const order = await this.prisma.order.count({
      where: { id: input.orderId },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    const written = await this.prisma.ledgerEntry.count({
      where: { subjectType: 'ORDER', subjectId: input.orderId },
    });
    if (written) {
      throw new ConflictException(
        'Cette commande est déjà au grand livre : contre-passez ses écritures avant de l’exclure.',
      );
    }
    try {
      return await this.prisma.ledgerExcludedOrder.create({
        data: {
          orderId: input.orderId,
          reason: input.reason.trim(),
          createdBy: input.actorUserId,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Commande déjà exclue.');
      }
      throw err;
    }
  }

  /**
   * Ce que Lilia doit à un vendeur selon le grand livre (positif = dû au
   * vendeur ; négatif = dette du vendeur). Reconstruit, jamais stocké.
   */
  async vendorBalance(restaurantId: string): Promise<number> {
    const agg = await this.prisma.ledgerEntry.aggregate({
      where: { account: 'vendor_payable', subjectId: restaurantId },
      _sum: { amountXaf: true },
    });
    // `0 - x` et non `-x` : `-0` n'est pas égal à 0 pour `Object.is`.
    return 0 - (agg._sum.amountXaf ?? 0);
  }
}
