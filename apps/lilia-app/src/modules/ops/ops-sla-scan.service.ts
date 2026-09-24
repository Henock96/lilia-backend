import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IncidentSeverity, IncidentType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';
import { AdminAlertService } from '../notifications/admin-alert.service';
import { brazzavilleClock } from '../vendors/vendor-opening.policy';
import { OpsBucket, OpsQueueService, SLA_BUCKETS } from './ops-queue.service';

/** Échec de paiement anormal (R-04.3) : > 30 % sur 1 h, avec ≥ 10 tentatives. */
export const PAYMENT_FAILURE = {
  windowMinutes: 60,
  minAttempts: 10,
  maxFailureRate: 0.3,
} as const;

const OPEN = ['OPEN', 'IN_PROGRESS'] as const;
const PAYMENT_FAILURE_KEY = 'metric:payment_failure';

export const slaKey = (bucket: string, id: string) => `ops:${bucket}:${id}`;

/** Heures calmes (R-04.5) : 23 h – 7 h à Brazzaville. */
export function isQuietHours(now: Date): boolean {
  const { minutes } = brazzavilleClock(now);
  return minutes >= 23 * 60 || minutes < 7 * 60;
}

/**
 * Taux d'échec de paiement sur la fenêtre : `null` quand il y a trop peu de
 * tentatives pour conclure (3 échecs sur 4 essais ne sont pas une panne).
 */
export function paymentFailureRate(
  total: number,
  failed: number,
): number | null {
  if (total < PAYMENT_FAILURE.minAttempts) return null;
  return failed / total;
}

/**
 * Alerting métier du cockpit ops (F3-04), chaque minute sur le worker.
 *
 *  - Chaque carte d'une file SLA ouvre **un** incident `OPS_SLA_BREACH`, clé
 *    `ops:<file>:<id>`. L'index unique partiel `Incident_dedupKey_open_uq`
 *    garantit l'unicité même si deux workers passent à la même minute
 *    (`skipDuplicates` → `ON CONFLICT DO NOTHING`), R-04.1.
 *  - Une carte disparue ⇒ son incident passe `RESOLVED`, `autoResolved`, R-04.2.
 *  - Une seule alerte admin par passage, qui résume les nouveautés : dix
 *    commandes en retard ne doivent pas envoyer dix e-mails.
 */
@Injectable()
export class OpsSlaScanService {
  private readonly logger = new Logger(OpsSlaScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: OpsQueueService,
    private readonly alerts: AdminAlertService,
    private readonly cronLock: CronLockService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'ops-sla-scan' })
  async scan(): Promise<void> {
    await this.cronLock.runExclusively('ops-sla-scan', 50, () =>
      this.scanUnlocked(new Date()),
    );
  }

  async scanUnlocked(now: Date) {
    const buckets = await this.queue.queue(now, { itemsPerBucket: 500 });
    const opened = await this.syncSlaIncidents(buckets, now);
    const paymentOpened = await this.syncPaymentFailure(now);

    if (opened.length > 0 || paymentOpened) {
      await this.alert(opened, paymentOpened, now);
    }
    return { opened: opened.length, paymentOpened };
  }

  private async syncSlaIncidents(buckets: OpsBucket[], now: Date) {
    const sla = buckets.filter((b) => SLA_BUCKETS.includes(b.key));
    const current = sla.flatMap((b) =>
      b.items.map((item) => ({ bucket: b, item, key: slaKey(b.key, item.id) })),
    );

    // Clés déjà ouvertes : pour annoncer seulement ce qui est nouveau.
    const alreadyOpen = new Set(
      (
        await this.prisma.incident.findMany({
          where: {
            type: IncidentType.OPS_SLA_BREACH,
            status: { in: [...OPEN] },
            dedupKey: { not: null },
          },
          select: { dedupKey: true },
        })
      ).map((i) => i.dedupKey!),
    );
    const fresh = current.filter((c) => !alreadyOpen.has(c.key));

    if (fresh.length) {
      await this.prisma.incident.createMany({
        data: fresh.map(({ bucket, item, key }) => ({
          type: IncidentType.OPS_SLA_BREACH,
          severity: IncidentSeverity.HIGH,
          title: `${bucket.label} — ${item.title}`,
          description: item.detail ?? bucket.label,
          orderId: item.orderId,
          dedupKey: key,
          metadata: { bucket: bucket.key, since: item.since },
        })),
        // L'index unique partiel départage deux workers concurrents.
        skipDuplicates: true,
      });
    }

    // R-04.2 — la cause a disparu : l'incident se clôt seul.
    const stillTrue = current.map((c) => c.key);
    const { count: resolved } = await this.prisma.incident.updateMany({
      where: {
        type: IncidentType.OPS_SLA_BREACH,
        status: { in: [...OPEN] },
        dedupKey: { startsWith: 'ops:', notIn: stillTrue },
      },
      data: {
        status: 'RESOLVED',
        autoResolved: true,
        resolvedAt: now,
        resolution: 'Condition levée — clôturé par le système.',
      },
    });
    if (fresh.length || resolved) {
      this.logger.log(
        `Cockpit ops : ${fresh.length} ouvert(s), ${resolved} clos`,
      );
    }
    return fresh;
  }

  /** `true` quand l'anomalie vient d'être ouverte (pas à chaque minute). */
  private async syncPaymentFailure(now: Date): Promise<boolean> {
    const since = new Date(
      now.getTime() - PAYMENT_FAILURE.windowMinutes * 60_000,
    );
    const rows = await this.prisma.payment.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    const total = rows.reduce((s, r) => s + r._count._all, 0);
    const failed = rows
      .filter((r) => r.status === 'FAILED')
      .reduce((s, r) => s + r._count._all, 0);
    const rate = paymentFailureRate(total, failed);
    const anomalous = rate !== null && rate > PAYMENT_FAILURE.maxFailureRate;

    if (!anomalous) {
      await this.prisma.incident.updateMany({
        where: { dedupKey: PAYMENT_FAILURE_KEY, status: { in: [...OPEN] } },
        data: {
          status: 'RESOLVED',
          autoResolved: true,
          resolvedAt: now,
          resolution: 'Taux d’échec revenu sous le seuil.',
        },
      });
      return false;
    }

    const { count } = await this.prisma.incident.createMany({
      data: [
        {
          type: IncidentType.METRIC_ANOMALY,
          severity: IncidentSeverity.CRITICAL,
          title: `Paiements : ${Math.round(rate * 100)} % d’échecs sur 1 h`,
          description: `${failed} échecs sur ${total} tentatives depuis ${PAYMENT_FAILURE.windowMinutes} min.`,
          dedupKey: PAYMENT_FAILURE_KEY,
          metadata: { total, failed },
        },
      ],
      skipDuplicates: true,
    });
    return count > 0;
  }

  private async alert(
    opened: Array<{ bucket: OpsBucket }>,
    paymentOpened: boolean,
    now: Date,
  ) {
    // R-04.5 : la nuit, seul le critique réveille. Les cartes restent visibles.
    if (isQuietHours(now) && !paymentOpened) return;

    const perBucket = new Map<string, number>();
    for (const { bucket } of opened) {
      perBucket.set(bucket.label, (perBucket.get(bucket.label) ?? 0) + 1);
    }
    const lines = [...perBucket].map(([label, n]) => `• ${label} : ${n}`);
    if (paymentOpened)
      lines.unshift('• Paiements : taux d’échec anormal (CRITIQUE)');

    const base = this.config.get<string>('ADMIN_WEB_URL');
    await this.alerts.notify({
      title: paymentOpened
        ? '🚨 Cockpit ops : anomalie critique'
        : `⚠️ Cockpit ops : ${opened.length} nouvelle(s) carte(s) à traiter`,
      body: lines.join('\n'),
      data: { type: 'ops_queue' },
      ...(base ? { href: `${base.replace(/\/$/, '')}/a-traiter` } : {}),
    });
  }
}
