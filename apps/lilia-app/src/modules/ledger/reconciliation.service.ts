import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { pspAccount } from './ledger-accounts';
import {
  Finding,
  LiliaOperation,
  ProviderRow,
  RULES,
  compareProviderRows,
  compareWalletBalance,
  finding,
} from './reconciliation-rules';

/**
 * Au-delà, l'export se découpe en plusieurs périodes. Borné par la limite de
 * corps JSON par défaut (100 ko, ~120 octets par ligne) que ce lot ne relève
 * pas ; une journée Lilia en est loin.
 */
export const MAX_IMPORT_ROWS = 800;
/** Une opération « en cours » plus vieille que ça est un écart. */
export const STALE_IN_FLIGHT_HOURS = 24;
/** Délai laissé au posteur avant qu'un transit résiduel soit un écart. */
export const CLEARING_GRACE_HOURS = 48;
export const MIN_RESOLUTION_NOTE = 10;

export const RESOLUTION_KINDS = [
  'EXPLAINED',
  'CORRECTED',
  'WRITTEN_OFF',
] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

const PROVIDER = 'PAWAPAY';
const HOUR = 3_600_000;

export interface RunReport {
  runId: string;
  /** `true` : export déjà importé, rien n'a été réécrit. */
  duplicate: boolean;
  findings: number;
  opened: number;
  reopened: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/** Contrôle défensif : le DTO valide déjà, le service ne fait confiance à personne. */
export function assertProviderRows(rows: ProviderRow[]): void {
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new BadRequestException(
      `Export trop volumineux (${rows.length} lignes, ${MAX_IMPORT_ROWS} au plus) : découpez la période.`,
    );
  }
  for (const [i, r] of rows.entries()) {
    const bad =
      !r.externalId ||
      r.externalId.length > 128 ||
      (r.kind !== 'DEPOSIT' && r.kind !== 'PAYOUT') ||
      !Number.isSafeInteger(r.amountXaf) ||
      r.amountXaf < 0 ||
      (r.feeXaf != null && (!Number.isSafeInteger(r.feeXaf) || r.feeXaf < 0));
    if (bad) {
      throw new BadRequestException(
        `Ligne ${i + 1} de l'export invalide (identifiant, sens ou montant entier XAF).`,
      );
    }
  }
}

/** Empreinte de l'export normalisé — indépendante de l'ordre des lignes. */
export function exportHash(input: {
  periodStart: Date;
  periodEnd: Date;
  walletBalanceXaf?: number | null;
  rows: ProviderRow[];
}): string {
  const rows = input.rows
    .map((r) => [
      r.kind,
      r.externalId,
      r.status,
      r.amountXaf,
      r.currency,
      r.feeXaf ?? null,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: PROVIDER,
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
        walletBalanceXaf: input.walletBalanceXaf ?? null,
        rows,
      }),
    )
    .digest('hex');
}

/**
 * Rapprochement Lilia ↔ prestataire (lot 2, 30/10/2026).
 *
 * Lit, compare, consigne. Ne corrige RIEN : ni statut de paiement, ni
 * versement, ni écriture comptable. Un écart se résout par un administrateur,
 * avec un motif ; il ne se ferme jamais tout seul, même s'il disparaît de
 * l'export suivant.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Passages ─────────────────────────────────────────────────────────────

  async importProviderExport(input: {
    periodStart: Date;
    periodEnd: Date;
    walletBalanceXaf?: number | null;
    rows: ProviderRow[];
    actorUserId: string;
    now?: Date;
  }): Promise<RunReport> {
    if (!(input.periodStart < input.periodEnd)) {
      throw new BadRequestException('La période est vide ou inversée.');
    }
    assertProviderRows(input.rows);
    const sourceHash = exportHash(input);

    let runId: string;
    try {
      runId = (
        await this.prisma.reconciliationRun.create({
          data: {
            kind: 'PROVIDER_EXPORT',
            provider: PROVIDER,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            sourceHash,
            rowCount: input.rows.length,
            walletBalanceXaf: input.walletBalanceXaf ?? null,
            createdBy: input.actorUserId,
          },
          select: { id: true },
        })
      ).id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.prisma.reconciliationRun.findUniqueOrThrow({
        where: { provider_sourceHash: { provider: PROVIDER, sourceHash } },
        select: { id: true, findingsCount: true },
      });
      return {
        runId: existing.id,
        duplicate: true,
        findings: existing.findingsCount,
        opened: 0,
        reopened: 0,
      };
    }

    const operations = await this.liliaOperations(input);
    const pspBalance = await this.ledgerPspBalance(input.periodEnd);
    const findings = [
      ...compareProviderRows(input.rows, operations),
      ...compareWalletBalance(input.walletBalanceXaf, pspBalance),
      ...(await this.internalFindings(input.now ?? new Date())),
    ];
    return this.persist(runId, findings);
  }

  /** Contrôles sur la base seule (opérations bloquées, preuves, transit). */
  async scanInternal(input: {
    actorUserId: string;
    now?: Date;
  }): Promise<RunReport> {
    const now = input.now ?? new Date();
    const run = await this.prisma.reconciliationRun.create({
      data: {
        kind: 'INTERNAL_SCAN',
        provider: PROVIDER,
        periodStart: new Date(now.getTime() - 30 * 24 * HOUR),
        periodEnd: now,
        createdBy: input.actorUserId,
      },
      select: { id: true },
    });
    return this.persist(run.id, await this.internalFindings(now));
  }

  // ── Lecture des faits Lilia ──────────────────────────────────────────────

  /**
   * Opérations Lilia à comparer : celles que l'export cite, plus celles
   * conclues chez Lilia dans la période (pour voir celles que l'export omet).
   */
  private async liliaOperations(input: {
    periodStart: Date;
    periodEnd: Date;
    rows: ProviderRow[];
  }): Promise<LiliaOperation[]> {
    const ids = (kind: ProviderRow['kind']) =>
      input.rows.filter((r) => r.kind === kind).map((r) => r.externalId);
    const period = { gte: input.periodStart, lt: input.periodEnd };
    const inPeriod = (d: Date | null) =>
      d != null && d >= input.periodStart && d < input.periodEnd;

    const [payments, payouts, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          provider: PROVIDER,
          providerTransactionId: { not: null },
          OR: [
            { providerTransactionId: { in: ids('DEPOSIT') } },
            { status: 'SUCCESS', completedAt: period },
          ],
        },
        select: {
          id: true,
          orderId: true,
          status: true,
          amount: true,
          currency: true,
          providerTransactionId: true,
          collectionFeeXaf: true,
          completedAt: true,
          order: { select: { restaurantId: true } },
        },
      }),
      this.prisma.restaurantPayout.findMany({
        where: {
          provider: PROVIDER,
          providerPayoutId: { not: null },
          OR: [
            { providerPayoutId: { in: ids('PAYOUT') } },
            { status: 'SUCCESS', completedAt: period },
          ],
        },
        select: {
          id: true,
          orderId: true,
          restaurantId: true,
          status: true,
          amount: true,
          currency: true,
          providerPayoutId: true,
          payoutFeeXaf: true,
          completedAt: true,
        },
      }),
      this.prisma.refund.findMany({
        where: {
          provider: PROVIDER,
          providerRefundId: { not: null },
          OR: [
            { providerRefundId: { in: ids('PAYOUT') } },
            { status: 'COMPLETED', processedAt: period },
          ],
        },
        select: {
          id: true,
          orderId: true,
          status: true,
          amount: true,
          providerRefundId: true,
          failureCode: true,
          processedAt: true,
          order: { select: { restaurantId: true } },
        },
      }),
    ]);

    return [
      ...payments.map(
        (p): LiliaOperation => ({
          externalId: p.providerTransactionId!,
          kind: 'DEPOSIT',
          entity: 'Payment',
          entityId: p.id,
          status: p.status,
          amountXaf: p.amount,
          currency: p.currency,
          feeXaf: p.collectionFeeXaf,
          restaurantId: p.order?.restaurantId ?? null,
          orderId: p.orderId,
          concludedInPeriod: p.status === 'SUCCESS' && inPeriod(p.completedAt),
        }),
      ),
      ...payouts.map(
        (p): LiliaOperation => ({
          externalId: p.providerPayoutId!,
          kind: 'PAYOUT',
          entity: 'RestaurantPayout',
          entityId: p.id,
          status: p.status,
          amountXaf: p.amount,
          currency: p.currency,
          feeXaf: p.payoutFeeXaf,
          restaurantId: p.restaurantId,
          orderId: p.orderId,
          concludedInPeriod: p.status === 'SUCCESS' && inPeriod(p.completedAt),
        }),
      ),
      ...refunds.map(
        (r): LiliaOperation => ({
          externalId: r.providerRefundId!,
          kind: 'PAYOUT',
          entity: 'Refund',
          entityId: r.id,
          // Un remboursement refusé par le prestataire revient en PENDING avec
          // un code d'échec : c'est un échec, pour la comparaison.
          status: r.status === 'PENDING' && r.failureCode ? 'FAILED' : r.status,
          amountXaf: r.amount,
          currency: 'XAF',
          feeXaf: null,
          restaurantId: r.order?.restaurantId ?? null,
          orderId: r.orderId,
          concludedInPeriod:
            r.status === 'COMPLETED' && inPeriod(r.processedAt),
        }),
      ),
    ];
  }

  /** Solde du compte prestataire au grand livre, faits antérieurs à `at`. */
  private async ledgerPspBalance(at: Date): Promise<number> {
    const agg = await this.prisma.ledgerEntry.aggregate({
      where: { account: pspAccount(PROVIDER), tx: { occurredAt: { lt: at } } },
      _sum: { amountXaf: true },
    });
    return agg._sum.amountXaf ?? 0;
  }

  /** Écarts visibles sur la base seule, sans export. */
  async internalFindings(now: Date): Promise<Finding[]> {
    const staleBefore = new Date(now.getTime() - STALE_IN_FLIGHT_HOURS * HOUR);
    const graceBefore = new Date(now.getTime() - CLEARING_GRACE_HOURS * HOUR);

    const [stalePayouts, staleRefunds, unprovenRefunds, residuals] =
      await Promise.all([
        this.prisma.restaurantPayout.findMany({
          where: {
            status: 'PENDING',
            provider: { not: 'NETTING' },
            requestedAt: { lt: staleBefore },
          },
          select: {
            id: true,
            orderId: true,
            restaurantId: true,
            amount: true,
            providerPayoutId: true,
            requestedAt: true,
          },
          take: 500,
        }),
        this.prisma.refund.findMany({
          where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
          select: {
            id: true,
            orderId: true,
            amount: true,
            providerRefundId: true,
            order: { select: { restaurantId: true } },
          },
          take: 500,
        }),
        this.prisma.refund.findMany({
          where: { status: 'COMPLETED', closureMethod: null },
          select: {
            id: true,
            orderId: true,
            amount: true,
            order: { select: { restaurantId: true } },
          },
          take: 500,
        }),
        this.prisma.$queryRaw<
          { orderId: string; restaurantId: string; balance: number }[]
        >`
          SELECT e."subjectId" AS "orderId", o."restaurantId",
                 SUM(e."amountXaf")::int AS balance
            FROM "LedgerEntry" e
            JOIN "Order" o ON o.id = e."subjectId"
           WHERE e.account = 'clearing:order'
             AND o.status IN ('LIVRER', 'ANNULER', 'ECHEC_LIVRAISON')
             AND o."updatedAt" < ${graceBefore}
           GROUP BY e."subjectId", o."restaurantId"
          HAVING SUM(e."amountXaf") <> 0
           LIMIT 500`,
      ]);

    return [
      ...stalePayouts.map((p) =>
        finding('STALE_IN_FLIGHT', `payout:${p.id}`, {
          restaurantId: p.restaurantId,
          orderId: p.orderId,
          payoutId: p.id,
          externalId: p.providerPayoutId,
          expectedXaf: p.amount,
          detail: `Versement en attente du prestataire depuis le ${p.requestedAt.toISOString()}`,
        }),
      ),
      ...staleRefunds.map((r) =>
        finding('STALE_IN_FLIGHT', `refund:${r.id}`, {
          restaurantId: r.order?.restaurantId ?? null,
          orderId: r.orderId,
          refundId: r.id,
          externalId: r.providerRefundId,
          expectedXaf: r.amount,
          detail: `Remboursement en cours depuis plus de ${STALE_IN_FLIGHT_HOURS} h`,
        }),
      ),
      ...unprovenRefunds.map((r) =>
        finding('REFUND_WITHOUT_PROOF', `refund:${r.id}`, {
          restaurantId: r.order?.restaurantId ?? null,
          orderId: r.orderId,
          refundId: r.id,
          expectedXaf: r.amount,
          detail:
            'Remboursement « terminé » sans méthode ni référence de clôture',
        }),
      ),
      ...residuals.map((x) =>
        finding('CLEARING_RESIDUAL', `order:${x.orderId}`, {
          restaurantId: x.restaurantId,
          orderId: x.orderId,
          expectedXaf: 0,
          actualXaf: x.balance,
          detail: `Transit de ${x.balance} XAF sur une commande close`,
        }),
      ),
    ];
  }

  // ── Écriture des écarts ──────────────────────────────────────────────────

  private async persist(
    runId: string,
    findings: Finding[],
  ): Promise<RunReport> {
    let opened = 0;
    let reopened = 0;
    for (const f of findings) {
      const outcome = await this.upsertItem(runId, f);
      if (outcome === 'OPENED') opened++;
      if (outcome === 'REOPENED') reopened++;
    }
    await this.prisma.reconciliationRun.update({
      where: { id: runId },
      data: { findingsCount: findings.length },
    });
    this.logger.log(
      `Rapprochement ${runId} : ${findings.length} écart(s), ${opened} nouveau(x), ${reopened} rouvert(s)`,
    );
    return {
      runId,
      duplicate: false,
      findings: findings.length,
      opened,
      reopened,
    };
  }

  /**
   * Un écart = un élément, quelle que soit la fréquence à laquelle on le revoit.
   *  · nouveau → ouvert (`OPENED`) ;
   *  · déjà ouvert → « revu » (dates et montants à jour, pas d'événement) ;
   *  · résolu, mêmes montants → reste résolu (l'explication tient toujours) ;
   *  · résolu, montants CHANGÉS → rouvert (`REOPENED`) : l'explication
   *    portait sur d'autres chiffres.
   */
  private async upsertItem(
    runId: string,
    f: Finding,
  ): Promise<'OPENED' | 'SEEN' | 'REOPENED'> {
    const rule = RULES[f.type];
    // Un blocage « vendeur » sans vendeur ne bloquerait personne.
    const blockScope =
      rule.block === 'VENDOR' && !f.restaurantId ? 'GLOBAL' : rule.block;
    const figures = {
      restaurantId: f.restaurantId ?? null,
      orderId: f.orderId ?? null,
      paymentId: f.paymentId ?? null,
      payoutId: f.payoutId ?? null,
      refundId: f.refundId ?? null,
      externalId: f.externalId ?? null,
      expectedXaf: f.expectedXaf ?? null,
      actualXaf: f.actualXaf ?? null,
      detail: f.detail,
    };
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.reconciliationItem.findUnique({
        where: { itemKey: f.itemKey },
        select: {
          id: true,
          status: true,
          expectedXaf: true,
          actualXaf: true,
        },
      });

      if (!existing) {
        const created = await tx.reconciliationItem.create({
          data: {
            itemKey: f.itemKey,
            type: f.type,
            severity: f.severity,
            blockScope,
            ...figures,
            firstRunId: runId,
            lastRunId: runId,
            firstSeenAt: now,
            lastSeenAt: now,
          },
          select: { id: true },
        });
        await tx.reconciliationItemEvent.create({
          data: { itemId: created.id, kind: 'OPENED', runId, note: f.detail },
        });
        return 'OPENED';
      }

      const changed =
        existing.expectedXaf !== figures.expectedXaf ||
        existing.actualXaf !== figures.actualXaf;
      if (existing.status === 'RESOLVED' && changed) {
        // Rouvert sous condition du statut lu : une résolution concurrente
        // n'est pas écrasée en silence.
        const res = await tx.reconciliationItem.updateMany({
          where: { id: existing.id, status: 'RESOLVED' },
          data: {
            ...figures,
            status: 'OPEN',
            resolutionKind: null,
            resolutionNote: null,
            resolvedAt: null,
            resolvedBy: null,
            lastRunId: runId,
            lastSeenAt: now,
          },
        });
        if (res.count === 1) {
          await tx.reconciliationItemEvent.create({
            data: {
              itemId: existing.id,
              kind: 'REOPENED',
              runId,
              note: `Montants changés (attendu ${existing.expectedXaf ?? '—'} → ${figures.expectedXaf ?? '—'}, constaté ${existing.actualXaf ?? '—'} → ${figures.actualXaf ?? '—'})`,
            },
          });
          return 'REOPENED';
        }
      }

      await tx.reconciliationItem.update({
        where: { id: existing.id },
        data:
          existing.status === 'OPEN'
            ? { ...figures, lastRunId: runId, lastSeenAt: now }
            : { lastRunId: runId, lastSeenAt: now },
      });
      return 'SEEN';
    });
  }

  // ── Gestes humains ───────────────────────────────────────────────────────

  async resolve(input: {
    itemId: string;
    kind: ResolutionKind;
    note: string;
    actorUserId: string;
  }) {
    const note = input.note?.trim() ?? '';
    if (!RESOLUTION_KINDS.includes(input.kind)) {
      throw new BadRequestException('Type de résolution inconnu.');
    }
    if (note.length < MIN_RESOLUTION_NOTE) {
      throw new BadRequestException(
        `Motif obligatoire (${MIN_RESOLUTION_NOTE} caractères au moins) : dites ce qui explique l'écart ou ce qui a été corrigé.`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.reconciliationItem.updateMany({
        where: { id: input.itemId, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolutionKind: input.kind,
          resolutionNote: note,
          resolvedAt: new Date(),
          resolvedBy: input.actorUserId,
        },
      });
      if (res.count === 0) {
        const exists = await tx.reconciliationItem.count({
          where: { id: input.itemId },
        });
        if (!exists) throw new NotFoundException('Écart introuvable.');
        throw new ConflictException({
          message: 'Cet écart est déjà résolu.',
          code: 'RECONCILIATION_ITEM_NOT_OPEN',
        });
      }
      await tx.reconciliationItemEvent.create({
        data: {
          itemId: input.itemId,
          kind: 'RESOLVED',
          actorUserId: input.actorUserId,
          note: `${input.kind} — ${note}`,
        },
      });
      return tx.reconciliationItem.findUniqueOrThrow({
        where: { id: input.itemId },
      });
    });
  }

  async addNote(input: { itemId: string; note: string; actorUserId: string }) {
    const note = input.note?.trim() ?? '';
    if (!note) throw new BadRequestException('Note vide.');
    const exists = await this.prisma.reconciliationItem.count({
      where: { id: input.itemId },
    });
    if (!exists) throw new NotFoundException('Écart introuvable.');
    return this.prisma.reconciliationItemEvent.create({
      data: {
        itemId: input.itemId,
        kind: 'NOTE',
        actorUserId: input.actorUserId,
        note,
      },
    });
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  async summary() {
    const open = await this.prisma.reconciliationItem.groupBy({
      by: ['blockScope', 'severity'],
      where: { status: 'OPEN' },
      _count: { _all: true },
    });
    const lastRun = await this.prisma.reconciliationRun.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        kind: true,
        periodStart: true,
        periodEnd: true,
        findingsCount: true,
        createdAt: true,
      },
    });
    const count = (pred: (r: (typeof open)[number]) => boolean) =>
      open.filter(pred).reduce((s, r) => s + r._count._all, 0);
    return {
      openItems: count(() => true),
      globalBlocking: count((r) => r.blockScope === 'GLOBAL'),
      vendorBlocking: count((r) => r.blockScope === 'VENDOR'),
      bySeverity: {
        CRITICAL: count((r) => r.severity === 'CRITICAL'),
        HIGH: count((r) => r.severity === 'HIGH'),
        MEDIUM: count((r) => r.severity === 'MEDIUM'),
      },
      payoutsGloballyBlocked: count((r) => r.blockScope === 'GLOBAL') > 0,
      lastRun,
    };
  }

  async listItems(q: {
    status?: 'OPEN' | 'RESOLVED';
    type?: string;
    restaurantId?: string;
    limit?: number;
    cursor?: string;
  }) {
    const take = Math.min(Math.max(q.limit ?? 50, 1), 100);
    const items = await this.prisma.reconciliationItem.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.restaurantId ? { restaurantId: q.restaurantId } : {}),
      },
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return {
      items: page.map((i) => ({
        ...i,
        procedure: RULES[i.type as keyof typeof RULES]?.procedure ?? null,
        label: RULES[i.type as keyof typeof RULES]?.label ?? i.type,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async getItem(id: string) {
    const item = await this.prisma.reconciliationItem.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!item) throw new NotFoundException('Écart introuvable.');
    const rule = RULES[item.type as keyof typeof RULES];
    return {
      ...item,
      label: rule?.label ?? item.type,
      procedure: rule?.procedure ?? null,
    };
  }

  listRuns(limit = 20) {
    return this.prisma.reconciliationRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }
}
