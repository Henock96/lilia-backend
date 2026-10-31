import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { CronLockService } from '../../apps/lilia-app/src/common/locks/cron-lock.service';

/**
 * Durcissement lot 4 — bail des crons (`CronLease`) sur PostgreSQL réel.
 *
 * Deux instances simulées (deux clients Prisma, donc deux pools) :
 *  - une seule exécute un job lancé au même instant ;
 *  - un bail échu (crash) est repris ;
 *  - une tâche qui a dépassé son bail ne libère pas celui de son successeur.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Bail des crons (PostgreSQL réel)', () => {
  let a: PrismaClient;
  let b: PrismaClient;
  const JOB = 'int-cron-lease';
  const originalFlag = process.env.RUN_BACKGROUND_JOBS;

  beforeAll(async () => {
    process.env.RUN_BACKGROUND_JOBS = 'true';
    a = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    b = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await Promise.all([a.$connect(), b.$connect()]);
  });

  beforeEach(async () => {
    await a.cronLease.deleteMany({ where: { jobName: JOB } });
  });

  afterAll(async () => {
    await a.cronLease.deleteMany({ where: { jobName: JOB } });
    await Promise.all([a.$disconnect(), b.$disconnect()]);
    if (originalFlag === undefined) delete process.env.RUN_BACKGROUND_JOBS;
    else process.env.RUN_BACKGROUND_JOBS = originalFlag;
  });

  it('deux instances au même instant : une seule exécute', async () => {
    const lockA = new CronLockService(a as never);
    const lockB = new CronLockService(b as never);
    let runs = 0;
    // La tâche dure : la seconde instance arrive pendant qu'elle tourne.
    const task = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 200));
      return 'fait';
    };

    const results = await Promise.all([
      lockA.runExclusively(JOB, 60, task),
      lockB.runExclusively(JOB, 60, task),
      lockA.runExclusively(JOB, 60, task),
      lockB.runExclusively(JOB, 60, task),
    ]);

    expect(runs).toBe(1);
    expect(results.filter((r) => r === 'fait')).toHaveLength(1);
    // Libéré en fin de tâche : le tick suivant n'attend pas l'échéance.
    expect(await a.cronLease.count({ where: { jobName: JOB } })).toBe(0);
  });

  it('un bail échu (instance tombée) est repris', async () => {
    await a.cronLease.create({
      data: {
        jobName: JOB,
        holder: 'instance-morte',
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const task = jest.fn().mockResolvedValue('fait');

    await expect(
      new CronLockService(b as never).runExclusively(JOB, 60, task),
    ).resolves.toBe('fait');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('un bail frais bloque, même après la fin du job ailleurs', async () => {
    await a.cronLease.create({
      data: {
        jobName: JOB,
        holder: 'autre-instance',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const task = jest.fn();

    await new CronLockService(b as never).runExclusively(JOB, 60, task);

    expect(task).not.toHaveBeenCalled();
    // Le bail d'autrui est intact.
    const lease = await a.cronLease.findUniqueOrThrow({
      where: { jobName: JOB },
    });
    expect(lease.holder).toBe('autre-instance');
  });

  it('⚠️ une tâche qui dépasse son bail ne libère pas celui du successeur', async () => {
    const lockA = new CronLockService(a as never);
    const lockB = new CronLockService(b as never);
    let successorHolder: string | undefined;

    await lockA.runExclusively(JOB, 1, async () => {
      // Le bail (1 s) expire pendant la tâche ; l'instance B le reprend.
      await new Promise((r) => setTimeout(r, 1_300));
      await lockB.runExclusively(JOB, 60, async () => {
        successorHolder = (
          await a.cronLease.findUniqueOrThrow({ where: { jobName: JOB } })
        ).holder;
        // A finit pendant que B tient le bail : on simule en ne rendant la
        // main qu'après la libération de A (voir l'assertion plus bas).
      });
      // B a libéré son bail ; on le repose pour vérifier que A n'y touche pas.
      await a.cronLease.create({
        data: {
          jobName: JOB,
          holder: successorHolder!,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    });

    expect(successorHolder).toBeDefined();
    const lease = await a.cronLease.findUnique({ where: { jobName: JOB } });
    expect(lease?.holder).toBe(successorHolder);
  });
});
