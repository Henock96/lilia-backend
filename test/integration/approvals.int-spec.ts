import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { AdminAuditService } from '../../apps/lilia-app/src/modules/admin-audit/admin-audit.service';
import { ApprovalsService } from '../../apps/lilia-app/src/modules/approvals/approvals.service';
import { ApprovalOutboxEffectsService } from '../../apps/lilia-app/src/modules/outbox/approval-outbox-effects.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { RefundExecutionService } from '../../apps/lilia-app/src/modules/refunds/refund-execution.service';

/**
 * **F3-08 — gestes financiers à deux administrateurs (PostgreSQL réel).**
 *
 * Les garanties sont en base : `approvedBy <> requestedBy` (CHECK), une seule
 * demande en attente par objet (index partiel), une approbation consommée une
 * fois (`UPDATE … WHERE status = 'APPROVED'`), et liée au geste exact
 * (`payloadHash`).
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Approbations à deux administrateurs (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let approvals: ApprovalsService;
  let refundExec: RefundExecutionService;
  const emitted: string[] = [];
  const sent: string[] = [];

  const A1 = 'ap-admin-1';
  const A2 = 'ap-admin-2';
  const A3 = 'ap-admin-3'; // sans FINANCE_APPROVE
  const VENDOR = 'ap-vendor';
  const ALL = [
    'FINANCE_EXECUTE',
    'FINANCE_APPROVE',
    'USER_ROLES',
    'SETTINGS',
    'SUPPORT',
  ] as const;

  const provider = {
    name: 'PAWAPAY',
    supportsPayout: true,
    createPayout: async (input: { payoutId: string }) => {
      sent.push(input.payoutId);
      return { accepted: true, duplicate: false, raw: {} };
    },
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const registry = { currentMode: 'PAWAPAY', forPayout: () => provider };
    const events = new EventEmitter2();
    events.onAny((name) => emitted.push(String(name)));
    refundExec = new RefundExecutionService(
      prisma as never,
      registry as never,
      new PaymentEventService(prisma as never),
    );
    approvals = new ApprovalsService(
      prisma as never,
      new AdminAuditService(prisma as never),
      new OutboxService(prisma as never),
      refundExec,
      { invalidate: async () => undefined } as never,
      events,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    emitted.length = 0;
    sent.length = 0;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "FinancialApproval", "AdminAuditLog", "OutboxEvent",
                     "PaymentEvent", "Refund", "payments", "OrderHistory",
                     "Order", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: A1,
          firebaseUid: 'fb-ap-1',
          email: 'ap1@test.local',
          role: 'ADMIN',
          adminCapabilities: [...ALL],
        },
        {
          id: A2,
          firebaseUid: 'fb-ap-2',
          email: 'ap2@test.local',
          role: 'ADMIN',
          adminCapabilities: [...ALL],
        },
        {
          id: A3,
          firebaseUid: 'fb-ap-3',
          email: 'ap3@test.local',
          role: 'ADMIN',
          adminCapabilities: ['SUPPORT'],
        },
        {
          id: 'ap-owner',
          firebaseUid: 'fb-ap-o',
          email: 'apo@test.local',
          role: 'RESTAURATEUR',
        },
        { id: 'ap-client', firebaseUid: 'fb-ap-c', email: 'apc@test.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Deux Signatures',
        adresse: 'Ouenzé',
        phone: '060000080',
        ownerId: 'ap-owner',
        payoutPhoneNumber: '242060000080',
        payoutProvider: 'MTN_MOMO',
      },
    });
  });

  const changePayload = {
    payoutPhoneNumber: '242069999999',
    payoutProvider: 'MTN_MOMO' as const,
    payoutAccountName: null,
  };
  const requestChange = () =>
    approvals.request({
      kind: 'PAYOUT_ACCOUNT_CHANGE',
      refId: VENDOR,
      payload: changePayload,
      requestedBy: A1,
      summary: 'test',
    });
  const vendorPhone = async () =>
    (await prisma.restaurant.findUniqueOrThrow({ where: { id: VENDOR } }))
      .payoutPhoneNumber;

  // ─── Numéro de versement ───────────────────────────────────────────────────

  it('la demande ne change rien ; l’approbation d’un AUTRE admin applique le numéro', async () => {
    const approval = await requestChange();
    expect(await vendorPhone()).toBe('242060000080');

    await approvals.approve(approval.id, A2);

    expect(await vendorPhone()).toBe('242069999999');
    const done = await prisma.financialApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(done).toMatchObject({ status: 'CONSUMED', approvedBy: A2 });
    expect(emitted).toContain('vendor.payout_account.changed');
    const restaurant = await prisma.restaurant.findUniqueOrThrow({
      where: { id: VENDOR },
    });
    expect(restaurant.payoutVerifiedAt).not.toBeNull(); // la carence de 24 h repart
  });

  it('R-08.4 — le demandeur ne peut pas approuver, ni par le service, ni en base', async () => {
    const approval = await requestChange();
    await expect(approvals.approve(approval.id, A1)).rejects.toMatchObject({
      response: { code: 'APPROVAL_SELF_FORBIDDEN' },
    });
    await expect(
      prisma.financialApproval.update({
        where: { id: approval.id },
        data: { status: 'APPROVED', approvedBy: A1, decidedAt: new Date() },
      }),
    ).rejects.toThrow(/check constraint|violates/i);
    expect(await vendorPhone()).toBe('242060000080');
  });

  it('une seule demande en attente par vendeur', async () => {
    await requestChange();
    await expect(requestChange()).rejects.toMatchObject({
      response: { code: 'APPROVAL_ALREADY_PENDING' },
    });
  });

  it('deux admins approuvent à la même seconde : le geste n’a lieu qu’une fois', async () => {
    const approval = await requestChange();
    await prisma.user.create({
      data: {
        id: 'ap-admin-4',
        firebaseUid: 'fb-ap-4',
        email: 'ap4@test.local',
        role: 'ADMIN',
        adminCapabilities: [...ALL],
      },
    });
    const results = await Promise.allSettled([
      approvals.approve(approval.id, A2),
      approvals.approve(approval.id, 'ap-admin-4'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.adminAuditLog.count({
        where: { action: 'VENDOR_PAYOUT_ACCOUNT_UPDATED' },
      }),
    ).toBe(1);
  });

  it('payloadHash — une demande altérée en base n’est pas applicable', async () => {
    const approval = await requestChange();
    await prisma.financialApproval.update({
      where: { id: approval.id },
      data: {
        payload: { ...changePayload, payoutPhoneNumber: '242061111111' },
      },
    });
    await expect(approvals.approve(approval.id, A2)).rejects.toMatchObject({
      response: { code: 'APPROVAL_NOT_USABLE' },
    });
    expect(await vendorPhone()).toBe('242060000080');
  });

  it('R-08.5 — une demande échue ne s’approuve plus', async () => {
    const approval = await requestChange();
    await prisma.financialApproval.update({
      where: { id: approval.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(approvals.approve(approval.id, A2)).rejects.toMatchObject({
      response: { code: 'APPROVAL_EXPIRED' },
    });
    expect(
      (
        await prisma.financialApproval.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status,
    ).toBe('EXPIRED');
  });

  it('refus par un autre admin, retrait par le demandeur', async () => {
    const a = await requestChange();
    await approvals.reject(a.id, A2, 'Numéro inconnu du vendeur');
    expect(
      (
        await prisma.financialApproval.findUniqueOrThrow({
          where: { id: a.id },
        })
      ).status,
    ).toBe('REJECTED');

    const b = await requestChange(); // plus rien en attente : nouvelle demande possible
    await approvals.reject(b.id, A1, 'Erreur de saisie');
    expect(
      (
        await prisma.financialApproval.findUniqueOrThrow({
          where: { id: b.id },
        })
      ).status,
    ).toBe('EXPIRED');
    expect(await vendorPhone()).toBe('242060000080');
  });

  it('les autres admins porteurs de FINANCE_APPROVE sont prévenus, pas le demandeur', async () => {
    const approval = await requestChange();
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { type: 'approval.requested', aggregateId: approval.id },
    });
    const pushed: string[] = [];
    const effects = new ApprovalOutboxEffectsService(
      prisma as never,
      new OutboxService(prisma as never),
      { registerHandler: () => undefined } as never,
      {
        sendPushNotification: async (id: string) => void pushed.push(id),
      } as never,
    );
    await effects.dispatchRequested(event);
    expect(pushed).toEqual([A2]);
  });

  // ─── Remboursement ≥ 50 000 ────────────────────────────────────────────────

  async function bigRefund(amount: number) {
    await prisma.order.create({
      data: {
        id: 'ap-order',
        restaurantId: VENDOR,
        userId: 'ap-client',
        subTotal: amount,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        total: amount,
        paymentMethod: 'MTN_MOMO',
        status: OrderStatus.ANNULER,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        orderId: 'ap-order',
        amount,
        phoneNumber: '242060000099',
        status: 'SUCCESS',
        provider: 'PAWAPAY',
        method: 'MTN_MOMO',
      },
    });
    return prisma.refund.create({
      data: {
        orderId: 'ap-order',
        paymentId: payment.id,
        amount,
        reason: 'Annulation',
      },
    });
  }

  it('D7 — un admin seul ne fait pas partir 60 000 FCFA ; l’approbation les fait partir, une fois', async () => {
    const refund = await bigRefund(60_000);
    await expect(refundExec.execute(refund.id, A1)).rejects.toMatchObject({
      response: { code: 'APPROVAL_REQUIRED' },
    });
    expect(sent).toHaveLength(0);

    const approval = await approvals.request({
      kind: 'REFUND_EXECUTION',
      refId: refund.id,
      payload: { refundId: refund.id, amountXaf: 60_000 },
      amountXaf: 60_000,
      requestedBy: A1,
      summary: 'test',
    });
    await approvals.approve(approval.id, A2);

    expect(sent).toHaveLength(1);
    expect(
      (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } }))
        .status,
    ).toBe('PROCESSING');
    await expect(
      refundExec.execute(refund.id, A1, { approvalId: approval.id }),
    ).rejects.toThrow(); // consommée : ne resservira pas
    expect(sent).toHaveLength(1);
  });

  it('remboursement automatique (système, D2) : hors des 4 yeux', async () => {
    const refund = await bigRefund(60_000);
    await refundExec.execute(refund.id, null);
    expect(sent).toHaveLength(1);
  });

  it('sous le seuil : un admin seul suffit', async () => {
    const refund = await bigRefund(49_999);
    await refundExec.execute(refund.id, A1);
    expect(sent).toHaveLength(1);
  });

  // ─── Capacités ─────────────────────────────────────────────────────────────

  it('attribution de capacités : effective seulement après un second admin', async () => {
    const approval = await approvals.request({
      kind: 'CAPABILITY_GRANT',
      refId: A3,
      payload: { capabilities: ['FINANCE_APPROVE', 'SUPPORT'] },
      requestedBy: A1,
      summary: 'test',
    });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: A3 } }))
        .adminCapabilities,
    ).toEqual(['SUPPORT']);
    await approvals.approve(approval.id, A2);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: A3 } }))
        .adminCapabilities,
    ).toEqual(['FINANCE_APPROVE', 'SUPPORT']);
    expect(
      await prisma.adminAuditLog.count({
        where: { action: 'CAPABILITY_CHANGED', targetId: A3 },
      }),
    ).toBe(1);
  });
});
