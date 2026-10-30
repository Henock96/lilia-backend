import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import {
  PaymentEventService,
  guardSignalOutcome,
} from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { PROVEN_WEBHOOK_WHERE } from '../../apps/lilia-app/src/modules/payments/webhook-proof';

/**
 * F-10 (audit du 28/10/2026) — la trace des signaux de paiement, sur
 * PostgreSQL réel avec la migration `payment_event_admin_failed` appliquée.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Trace des signaux de paiement (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let events: PaymentEventService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    events = new PaymentEventService(prisma as never);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "PaymentEvent"`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const record = (over: Record<string, unknown> = {}) =>
    events.record({
      kind: 'COLLECTION',
      provider: 'PAWAPAY',
      externalId: 'dep-1',
      source: 'WEBHOOK',
      rawStatus: 'COMPLETED',
      payload: { depositId: 'dep-1' },
      ...over,
    } as never);

  it('un traitement qui lève laisse la ligne FAILED_PROCESSING, et l’erreur remonte', async () => {
    const id = await record();

    await expect(
      guardSignalOutcome(events, id, async () => {
        throw new Error('base indisponible');
      }),
    ).rejects.toThrow('base indisponible');

    const row = await prisma.paymentEvent.findUniqueOrThrow({
      where: { id: id! },
    });
    expect(row.outcome).toBe('FAILED_PROCESSING');
  });

  it('un traitement qui aboutit ne touche pas l’issue qu’il a posée', async () => {
    const id = await record();
    await guardSignalOutcome(events, id, async () => {
      await events.setOutcome(id, 'DUPLICATE');
      return 'DUPLICATE';
    });
    const row = await prisma.paymentEvent.findUniqueOrThrow({
      where: { id: id! },
    });
    expect(row.outcome).toBe('DUPLICATE');
  });

  it('seuls les webhooks pawaPay appliqués ou reconnus prouvent la voie', async () => {
    await record(); // APPLIED par défaut → compte
    await record({ externalId: 'dep-2', outcome: 'DUPLICATE' }); // compte
    await record({ externalId: 'dep-3', outcome: 'IGNORED' }); // inconnue
    await record({ externalId: 'dep-4', outcome: 'FAILED_PROCESSING' });
    await record({
      externalId: 'p-5',
      provider: 'MANUAL',
      rawStatus: 'MANUAL_CONFIRMED',
    }); // historique
    await record({ externalId: 'p-6', provider: 'MANUAL', source: 'ADMIN' });
    await record({ externalId: 'dep-7', source: 'RECONCILIATION' });

    expect(
      await prisma.paymentEvent.count({ where: PROVEN_WEBHOOK_WHERE }),
    ).toBe(2);
  });
});
