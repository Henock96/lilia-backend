import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Outils pour **forcer** un entrelacement de transactions contre un vrai
 * PostgreSQL (F3-12).
 *
 * Répéter `Promise.all` cinquante fois explore des entrelacements au hasard :
 * utile pour débusquer un interblocage, insuffisant pour PROUVER qu'un
 * scénario précis est couvert — rien ne garantit que la fenêtre dangereuse a
 * été traversée ne serait-ce qu'une fois. Ces outils la traversent à coup sûr :
 *
 * ```
 * const held = await holdTransaction(prisma, (tx) => …écritures A…);  // A tient ses verrous
 * const b = operationB();                                             // B démarre…
 * await waitUntilBlocked(prisma);                                     // …et ATTEND un verrou de A
 * await held.commit();                                                // A commit
 * await b;                                                            // B relit un état à jour
 * ```
 *
 * `waitUntilBlocked` lit `pg_stat_activity` : c'est PostgreSQL qui confirme
 * que B est suspendu sur un verrou, pas une temporisation qui l'espère.
 */

const ROLLBACK = Symbol('rollback');

export interface HeldTransaction<T> {
  /** Résultat du travail fait avant la suspension. */
  readonly result: T;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function holdTransaction<T>(
  prisma: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<HeldTransaction<T>> {
  let resolveReady!: (value: T) => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<T>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let decide!: (outcome: 'commit' | typeof ROLLBACK) => void;
  const decision = new Promise<'commit' | typeof ROLLBACK>(
    (res) => (decide = res),
  );

  // Jamais rejetée : l'échec est conservé et relancé par `commit()`, pour
  // qu'aucune promesse ne reste rejetée sans que personne ne l'attende.
  let failure: unknown = null;
  const done = prisma
    .$transaction(
      async (tx) => {
        const result = await work(tx);
        resolveReady(result);
        if ((await decision) === ROLLBACK) throw ROLLBACK;
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .then(
      () => undefined,
      (err: unknown) => {
        if (err === ROLLBACK) return;
        failure = err;
        rejectReady(err);
      },
    );

  const result = await ready;
  return {
    result,
    commit: async () => {
      decide('commit');
      await done;
      if (failure) throw failure;
    },
    rollback: async () => {
      decide(ROLLBACK);
      await done;
    },
  };
}

/**
 * Transaction pilotée **pas à pas** : chaque `step` s'exécute dans la même
 * transaction, au moment choisi par le test. Indispensable pour reproduire un
 * cycle d'attente — « A tient R1, B prend R2 puis attend R1, A demande R2 » :
 * les deux demandes de A doivent appartenir à la MÊME transaction, sinon
 * aucun cycle ne peut se former et le test ne prouve rien.
 */
export interface SteppedTransaction {
  step<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

type Job =
  | {
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>;
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }
  | { end: 'commit' | 'rollback' };

export function openTransaction(prisma: PrismaClient): SteppedTransaction {
  const jobs: Job[] = [];
  let wake: (() => void) | null = null;
  const push = (job: Job) => {
    jobs.push(job);
    const w = wake;
    wake = null;
    w?.();
  };
  const next = () =>
    new Promise<Job>((resolve) => {
      const tick = () => {
        const job = jobs.shift();
        if (job) resolve(job);
        else wake = tick;
      };
      tick();
    });

  let failure: unknown = null;
  const done = prisma
    .$transaction(
      async (tx) => {
        for (;;) {
          const job = await next();
          if ('end' in job) {
            if (job.end === 'rollback') throw ROLLBACK;
            return;
          }
          try {
            job.resolve(await job.fn(tx));
          } catch (err) {
            job.reject(err);
            throw err;
          }
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .then(
      () => undefined,
      (err: unknown) => {
        if (err !== ROLLBACK) failure = err;
      },
    );

  return {
    step: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      new Promise<T>((resolve, reject) =>
        push({
          fn,
          resolve: resolve as (v: unknown) => void,
          reject,
        }),
      ),
    commit: async () => {
      push({ end: 'commit' });
      await done;
      if (failure) throw failure;
    },
    rollback: async () => {
      push({ end: 'rollback' });
      await done;
    },
  };
}

/**
 * Attend qu'au moins `count` sessions de la base courante soient suspendues
 * sur un verrou (`wait_event_type = 'Lock'`). Échoue au bout de `timeoutMs` :
 * une opération qui n'attend pas le verrou qu'on croyait la bloquer est
 * précisément ce que le test doit révéler.
 */
export async function waitUntilBlocked(
  prisma: PrismaClient,
  count = 1,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
    `;
    if (waiting >= count) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Aucune session bloquée sur un verrou après ${timeoutMs} ms (attendu : ${count}).`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Vrai si l'erreur est un interblocage PostgreSQL (40P01), quelle que soit la
 * couche qui l'a enveloppée (adaptateur `pg`, Prisma P2034/P2010).
 */
export function isDeadlock(err: unknown): boolean {
  const text = JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}));
  return (
    /40P01|deadlock/i.test(text) || (err as { code?: string })?.code === 'P2034'
  );
}

/** Les rejets d'un `Promise.allSettled`, pour les inspecter d'un coup. */
export function rejections(
  results: PromiseSettledResult<unknown>[],
): unknown[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);
}
