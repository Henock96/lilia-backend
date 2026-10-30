import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';

/**
 * Lot 1A/1B (audit du 28/10/2026) — les deux écritures SQL ajoutées à
 * l'outbox, sur un PostgreSQL réel :
 *
 *  - `deferUntil` reporte une obligation ENCORE due et ne rouvre jamais une
 *    obligation close ;
 *  - `claimUnreachableAlert` ne rend `true` qu'à UN appel, même concurrent :
 *    c'est ce qui empêche d'alerter les administrateurs à chaque reprise.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Outbox — report et alerte unique (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let outbox: OutboxService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    outbox = new OutboxService(prisma as never);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "OutboxEvent"`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const create = (status: 'PENDING' | 'SENT' = 'PENDING') =>
    prisma.outboxEvent.create({
      data: {
        type: 'order.paid',
        aggregateId: 'o-1',
        payload: { paymentId: 'p-1' },
        status,
      },
    });

  it('deferUntil reporte une obligation due sans compter de tentative', async () => {
    const e = await create();
    const at = new Date(Date.now() + 10 * 60_000);

    await outbox.deferUntil(e.id, at);

    const row = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: e.id },
    });
    expect(row.nextAttemptAt.getTime()).toBe(at.getTime());
    expect(row.attempts).toBe(0);
    expect(row.status).toBe('PENDING');
  });

  it('deferUntil ne touche pas une obligation déjà close', async () => {
    const e = await create('SENT');
    const before = e.nextAttemptAt.getTime();

    await outbox.deferUntil(e.id, new Date(Date.now() + 3_600_000));

    const row = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: e.id },
    });
    expect(row.nextAttemptAt.getTime()).toBe(before);
    expect(row.status).toBe('SENT');
  });

  it('claimUnreachableAlert : une seule alerte, même sous concurrence', async () => {
    const e = await create();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => outbox.claimUnreachableAlert(e.id)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: e.id },
    });
    const payload = row.payload as Record<string, unknown>;
    // Le payload d'origine est conservé, la marque est ajoutée.
    expect(payload.paymentId).toBe('p-1');
    expect(typeof payload.unreachableAlertedAt).toBe('string');
    expect(await outbox.claimUnreachableAlert(e.id)).toBe(false);
  });
});
