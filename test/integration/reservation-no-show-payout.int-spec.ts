import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';

import { AdminAuditService } from '../../apps/lilia-app/src/modules/admin-audit/admin-audit.service';
import { ApprovalsService } from '../../apps/lilia-app/src/modules/approvals/approvals.service';
import { LedgerPosterService } from '../../apps/lilia-app/src/modules/ledger/ledger-poster.service';
import { LedgerService } from '../../apps/lilia-app/src/modules/ledger/ledger.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { ProviderUnavailableError } from '../../apps/lilia-app/src/modules/payments/providers/payment-provider.interface';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { RefundExecutionService } from '../../apps/lilia-app/src/modules/refunds/refund-execution.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';
import { NoShowPayoutProviderService } from '../../apps/lilia-app/src/modules/reservations/no-show-payout-provider.service';
import { NoShowPayoutService } from '../../apps/lilia-app/src/modules/reservations/no-show-payout.service';

/**
 * **4B-2 J6b — versement de la part restaurant d'une absence (PostgreSQL réel).**
 *
 * Ce qu'un mock ne peut pas montrer :
 *  · quatre yeux en base (`approvedBy <> requestedBy`) et dans le service ;
 *  · au plus un versement en cours ou abouti par absence (index partiel),
 *    même quand deux écritures se croisent ;
 *  · un rejeu qui ne rappelle jamais le prestataire ;
 *  · le grand livre : la dette `vendor_payable` née de `FORFEIT` est soldée.
 *
 * Le prestataire est un double (aucun appel réseau).
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Versement de la part d’absence (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let approvals: ApprovalsService;
  let payouts: NoShowPayoutService;
  let outcomes: NoShowPayoutProviderService;
  let poster: LedgerPosterService;

  const A1 = 'nsp-admin-1';
  const A2 = 'nsp-admin-2';
  const VENDOR = 'nsp-vendor';
  const OWNER = 'nsp-owner';
  const SETTLEMENT = 'nsp-settlement';
  const ORDER = 'nsp-order';
  const SHARE = 4_250;
  const HOUR = 3_600_000;

  /** Ce que le double du prestataire a reçu. */
  const sent: { providerPayoutId: string; amountXaf: number; phone: string }[] =
    [];
  let behaviour: 'ACCEPT' | 'REJECT' | 'UNAVAILABLE' = 'ACCEPT';
  const provider = {
    name: 'PAWAPAY',
    supportsPayout: true,
    createPayout: async (input: {
      providerPayoutId: string;
      amountXaf: number;
      phoneNumber: string;
    }) => {
      sent.push({
        providerPayoutId: input.providerPayoutId,
        amountXaf: input.amountXaf,
        phone: input.phoneNumber,
      });
      if (behaviour === 'UNAVAILABLE') {
        throw new ProviderUnavailableError('timeout');
      }
      return behaviour === 'REJECT'
        ? {
            accepted: false,
            duplicate: false,
            failureCode: 'INVALID_RECIPIENT',
            failureMessage: 'Numéro inconnu',
            raw: {},
          }
        : { accepted: true, duplicate: false, raw: {} };
    },
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const registry = { currentMode: 'PAWAPAY', forPayout: () => provider };
    const events = new PaymentEventService(prisma as never);
    const outbox = new OutboxService(prisma as never);
    payouts = new NoShowPayoutService(
      prisma as never,
      registry as never,
      events,
    );
    outcomes = new NoShowPayoutProviderService(prisma as never, events, outbox);
    approvals = new ApprovalsService(
      prisma as never,
      new AdminAuditService(prisma as never),
      outbox,
      new RefundExecutionService(prisma as never, registry as never, events),
      { invalidate: async () => undefined } as never,
      new EventEmitter2(),
      new RefundsService(prisma as never),
      { invalidateCache: () => undefined } as never,
      payouts,
    );
    poster = new LedgerPosterService(
      prisma as never,
      new LedgerService(prisma as never),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    sent.length = 0;
    behaviour = 'ACCEPT';
    process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = '24';
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "ReservationNoShowPayout", "ReservationNoShowSettlement",
        "LedgerEntry", "LedgerTransaction", "LedgerPostingException",
        "FinancialApproval", "AdminAuditLog", "OutboxEvent", "PaymentEvent",
        "Incident", "Reservation", "ReservationSpace", "Order", "Restaurant",
        "User"
      RESTART IDENTITY CASCADE
    `);
    const all = [
      'FINANCE_EXECUTE',
      'FINANCE_APPROVE',
      'USER_ROLES',
      'SETTINGS',
      'SUPPORT',
    ] as const;
    await prisma.user.createMany({
      data: [
        {
          id: A1,
          firebaseUid: 'fb-nsp-1',
          email: 'nsp1@t.local',
          role: 'ADMIN',
          adminCapabilities: [...all],
        },
        {
          id: A2,
          firebaseUid: 'fb-nsp-2',
          email: 'nsp2@t.local',
          role: 'ADMIN',
          adminCapabilities: [...all],
        },
        {
          id: OWNER,
          firebaseUid: 'fb-nsp-o',
          email: 'nspo@t.local',
          role: 'RESTAURATEUR',
        },
        { id: 'nsp-client', firebaseUid: 'fb-nsp-c', email: 'nspc@t.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez l’Absent',
        adresse: 'Bacongo',
        phone: '060000081',
        ownerId: OWNER,
        payoutPhoneNumber: '242060000081',
        payoutProvider: 'MTN_MOMO',
        payoutVerifiedAt: new Date(Date.now() - 48 * HOUR),
      },
    });
    await prisma.reservationSpace.create({
      data: {
        id: 'nsp-table',
        restaurantId: VENDOR,
        kind: 'TABLE',
        label: 'Table 1',
        labelKey: 'table 1',
        minGuests: 1,
        maxGuests: 4,
      },
    });
    const arrivalAt = new Date(Date.now() - 20 * HOUR);
    await prisma.reservation.create({
      data: {
        id: 'nsp-resa',
        restaurantId: VENDOR,
        userId: 'nsp-client',
        spaceId: 'nsp-table',
        partySize: 2,
        arrivalAt,
        endsAt: new Date(arrivalAt.getTime() + 2 * HOUR),
        occupiedUntil: new Date(arrivalAt.getTime() + 2 * HOUR),
        contactPhone: '061234561',
        requestKey: 'nsp-key',
        responseDeadlineAt: new Date(arrivalAt.getTime() - 2 * HOUR),
        status: 'NO_SHOW',
        noShowAt: new Date(arrivalAt.getTime() + HOUR),
      },
    });
    await prisma.order.create({
      data: {
        id: ORDER,
        restaurantId: VENDOR,
        userId: 'nsp-client',
        subTotal: 8_500,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        total: 8_500,
        paymentMethod: 'MTN_MOMO',
        status: 'ANNULER',
      },
    });
    await prisma.reservationNoShowSettlement.create({
      data: {
        id: SETTLEMENT,
        reservationId: 'nsp-resa',
        orderId: ORDER,
        restaurantId: VENDOR,
        totalXaf: 8_500,
        vendorShareXaf: SHARE,
        platformShareXaf: 8_500 - SHARE,
        vendorShareBps: 5_000,
      },
    });
  });

  // ─── Outils ────────────────────────────────────────────────────────────────

  const codeOf = (e: unknown) =>
    (e as { getResponse?: () => { code?: string } }).getResponse?.()?.code;

  /** Ce que fait `POST /admin/reservation-no-shows/:id/payout`. */
  const request = async (by = A1) => {
    const prepared = await payouts.prepareRequest(SETTLEMENT);
    return approvals.request({
      kind: 'NO_SHOW_VENDOR_SHARE_PAYOUT',
      refId: SETTLEMENT,
      payload: { ...prepared.payload },
      amountXaf: prepared.amountXaf,
      requestedBy: by,
      summary: prepared.summary,
    });
  };

  const rows = () =>
    prisma.reservationNoShowPayout.findMany({ orderBy: { createdAt: 'asc' } });

  const webhook = (providerPayoutId: string, over: object = {}) =>
    outcomes.applyProviderStatus({
      payoutId: providerPayoutId,
      status: {
        state: 'SUCCESS',
        rawStatus: 'COMPLETED',
        amountXaf: SHARE,
        currency: 'XAF',
        providerTransactionId: 'pp-tx-1',
        raw: {},
        ...over,
      },
      source: 'WEBHOOK',
    });

  const resolveRow = async (providerPayoutId: string) => {
    const found = await outcomes.findByProviderPayoutId(
      'PAWAPAY',
      providerPayoutId,
    );
    return found!.id;
  };

  // ─── Demande ───────────────────────────────────────────────────────────────

  describe('demande', () => {
    it('ouvre une approbation : le numéro et l’opérateur sont dans la demande, rien ne part', async () => {
      const approval = await request();
      expect(approval).toMatchObject({
        kind: 'NO_SHOW_VENDOR_SHARE_PAYOUT',
        refId: SETTLEMENT,
        status: 'PENDING',
        amountXaf: SHARE,
        payload: {
          settlementId: SETTLEMENT,
          amountXaf: SHARE,
          phoneNumber: '242060000081',
          payoutProvider: 'MTN_MOMO',
        },
      });
      expect(await rows()).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('une seule demande en attente par absence', async () => {
      await request();
      await expect(request()).rejects.toSatisfy(
        (e) => codeOf(e) === 'APPROVAL_ALREADY_PENDING',
      );
    });

    it('compte jamais vérifié, en carence, ou changement en attente : refusé', async () => {
      await prisma.restaurant.update({
        where: { id: VENDOR },
        data: { payoutVerifiedAt: null },
      });
      await expect(request()).rejects.toSatisfy(
        (e) => codeOf(e) === 'NO_SHOW_PAYOUT_ACCOUNT_UNVERIFIED',
      );

      await prisma.restaurant.update({
        where: { id: VENDOR },
        data: { payoutVerifiedAt: new Date(Date.now() - HOUR) },
      });
      await expect(request()).rejects.toSatisfy(
        (e) => codeOf(e) === 'VENDOR_PAYOUT_ACCOUNT_COOLING_DOWN',
      );

      await prisma.restaurant.update({
        where: { id: VENDOR },
        data: { payoutVerifiedAt: new Date(Date.now() - 48 * HOUR) },
      });
      await approvals.request({
        kind: 'PAYOUT_ACCOUNT_CHANGE',
        refId: VENDOR,
        payload: {
          payoutPhoneNumber: '242069999999',
          payoutProvider: 'MTN_MOMO',
          payoutAccountName: null,
        },
        requestedBy: A1,
        summary: 'test',
      });
      await expect(request()).rejects.toSatisfy(
        (e) => codeOf(e) === 'NO_SHOW_PAYOUT_ACCOUNT_CHANGE_PENDING',
      );
    });

    it('part nulle : rien à verser', async () => {
      await prisma.reservationNoShowSettlement.update({
        where: { id: SETTLEMENT },
        data: { vendorShareXaf: 0, platformShareXaf: 8_500 },
      });
      await expect(request()).rejects.toSatisfy(
        (e) => codeOf(e) === 'NO_SHOW_PAYOUT_NOTHING_DUE',
      );
    });
  });

  // ─── Validation et envoi ───────────────────────────────────────────────────

  describe('validation et envoi', () => {
    it('le demandeur ne valide pas ; un autre admin valide et le virement part avec l’identifiant figé', async () => {
      const approval = await request();
      await expect(approvals.approve(approval.id, A1)).rejects.toSatisfy(
        (e) => codeOf(e) === 'APPROVAL_SELF_FORBIDDEN',
      );
      expect(sent).toEqual([]);

      const result = await approvals.approve(approval.id, A2);

      const [row] = await rows();
      expect(row).toMatchObject({
        settlementId: SETTLEMENT,
        restaurantId: VENDOR,
        amountXaf: SHARE,
        phoneNumber: '242060000081',
        payoutProvider: 'MTN_MOMO',
        provider: 'PAWAPAY',
        status: 'PENDING',
        requestedBy: A1,
        approvedBy: A2,
        approvalId: approval.id,
      });
      expect(sent).toEqual([
        {
          providerPayoutId: row.providerPayoutId,
          amountXaf: SHARE,
          phone: '242060000081',
        },
      ]);
      expect(result).toMatchObject({
        kind: 'NO_SHOW_VENDOR_SHARE_PAYOUT',
        execution: { status: 'PENDING' },
      });
      expect(
        await prisma.financialApproval.findUniqueOrThrow({
          where: { id: approval.id },
        }),
      ).toMatchObject({ status: 'CONSUMED', approvedBy: A2 });
    });

    it('P-2 — numéro changé entre la demande et la validation : 409, rien ne part', async () => {
      const approval = await request();
      await prisma.restaurant.update({
        where: { id: VENDOR },
        data: { payoutPhoneNumber: '242069999999' },
      });
      await expect(approvals.approve(approval.id, A2)).rejects.toSatisfy(
        (e) => codeOf(e) === 'NO_SHOW_PAYOUT_ACCOUNT_CHANGED',
      );
      expect(await rows()).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('prestataire injoignable : la ligne reste PENDING, un rejeu ne rappelle pas le prestataire', async () => {
      behaviour = 'UNAVAILABLE';
      const approval = await request();
      const result = await approvals.approve(approval.id, A2);
      expect(result).toMatchObject({ execution: { status: 'PENDING' } });
      expect(sent).toHaveLength(1);
      expect((await rows())[0].status).toBe('PENDING');

      await expect(approvals.approve(approval.id, A2)).rejects.toSatisfy(
        (e) =>
          codeOf(e) === 'APPROVAL_NOT_PENDING' ||
          codeOf(e) === 'APPROVAL_NOT_USABLE',
      );
      expect(sent).toHaveLength(1);
      expect(await rows()).toHaveLength(1);
    });

    it('refus du prestataire à l’envoi : FAILED, et une nouvelle demande devient possible', async () => {
      behaviour = 'REJECT';
      const first = await request();
      const result = await approvals.approve(first.id, A2);
      expect(result).toMatchObject({ execution: { status: 'FAILED' } });
      expect((await rows())[0]).toMatchObject({
        status: 'FAILED',
        failureCode: 'INVALID_RECIPIENT',
      });

      behaviour = 'ACCEPT';
      const second = await request();
      await approvals.approve(second.id, A2);
      const all = await rows();
      expect(all.map((r) => r.status)).toEqual(['FAILED', 'PENDING']);
      expect(all[0].providerPayoutId).not.toBe(all[1].providerPayoutId);
    });

    it('deux validations simultanées de la même demande : un seul virement', async () => {
      const approval = await request();
      await prisma.user.create({
        data: {
          id: 'nsp-admin-3',
          firebaseUid: 'fb-nsp-3',
          email: 'nsp3@t.local',
          role: 'ADMIN',
          adminCapabilities: ['FINANCE_APPROVE'],
        },
      });
      const results = await Promise.allSettled([
        approvals.approve(approval.id, A2),
        approvals.approve(approval.id, 'nsp-admin-3'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await rows()).toHaveLength(1);
      expect(sent).toHaveLength(1);
    });

    it('en base : deux versements actifs pour la même absence sont impossibles, et le valideur n’est jamais le demandeur', async () => {
      const base = {
        settlementId: SETTLEMENT,
        restaurantId: VENDOR,
        amountXaf: SHARE,
        phoneNumber: '242060000081',
        payoutProvider: 'MTN_MOMO' as const,
        provider: 'PAWAPAY',
        requestedBy: A1,
        approvedBy: A2,
      };
      await prisma.reservationNoShowPayout.create({
        data: { ...base, providerPayoutId: 'pp-1', approvalId: 'ap-1' },
      });
      await expect(
        prisma.reservationNoShowPayout.create({
          data: { ...base, providerPayoutId: 'pp-2', approvalId: 'ap-2' },
        }),
      ).rejects.toThrow(/Unique constraint|unique/i);
      await expect(
        prisma.reservationNoShowPayout.create({
          data: {
            ...base,
            status: 'FAILED',
            approvedBy: A1,
            providerPayoutId: 'pp-3',
            approvalId: 'ap-3',
          },
        }),
      ).rejects.toThrow(/check constraint|violates/i);
    });
  });

  // ─── Issue ─────────────────────────────────────────────────────────────────

  describe('issue', () => {
    const sentAndApproved = async () => {
      const approval = await request();
      await approvals.approve(approval.id, A2);
      return (await rows())[0];
    };

    it('webhook COMPLETED : SUCCESS, rejoué : DUPLICATE ; le restaurant est prévenu une fois', async () => {
      const row = await sentAndApproved();
      const id = await resolveRow(row.providerPayoutId);
      expect(await webhook(id)).toBe('APPLIED');
      expect(await webhook(id)).toBe('DUPLICATE');

      const done = (await rows())[0];
      expect(done).toMatchObject({
        status: 'SUCCESS',
        providerTransactionId: 'pp-tx-1',
      });
      expect(done.completedAt).not.toBeNull();

      const notices = await prisma.outboxEvent.findMany({
        where: { type: 'reservation.notice' },
      });
      expect(notices.map((n) => n.payload as Record<string, unknown>)).toEqual([
        expect.objectContaining({
          notice: 'NO_SHOW_SHARE_PAID',
          audience: 'VENDOR',
          recipientUserId: OWNER,
          payoutXaf: SHARE,
        }),
      ]);
      // Une nouvelle demande est refusée : la part est versée.
      await expect(request()).rejects.toSatisfy(
        (e) => codeOf(e) === 'NO_SHOW_PAYOUT_ALREADY_ACTIVE',
      );
    });

    it('webhook FAILED : terminal, aucun SUCCESS tardif ne le défait ; nouvelle demande possible', async () => {
      const row = await sentAndApproved();
      const id = await resolveRow(row.providerPayoutId);
      expect(
        await webhook(id, {
          state: 'FAILED',
          rawStatus: 'FAILED',
          failureCode: 'PAYER_LIMIT_REACHED',
        }),
      ).toBe('APPLIED');
      expect(await webhook(id)).toBe('DUPLICATE');
      expect((await rows())[0]).toMatchObject({
        status: 'FAILED',
        failureCode: 'PAYER_LIMIT_REACHED',
      });
      await expect(request()).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('montant ou devise différents, même d’un franc, ou absents d’un SUCCESS : rien n’est appliqué, un seul incident ouvert', async () => {
      const row = await sentAndApproved();
      const id = await resolveRow(row.providerPayoutId);
      expect(await webhook(id, { amountXaf: SHARE + 500 })).toBe('MISMATCH');
      expect(await webhook(id, { amountXaf: SHARE + 1 })).toBe('MISMATCH');
      expect(await webhook(id, { currency: 'EUR' })).toBe('MISMATCH');
      expect(await webhook(id, { currency: undefined })).toBe('MISMATCH');
      expect(await webhook(id, { amountXaf: undefined })).toBe('MISMATCH');
      expect((await rows())[0].status).toBe('PENDING');
      // Rejoué par la réconciliation toutes les 2 minutes : un seul incident.
      const incidents = await prisma.incident.findMany();
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        severity: 'CRITICAL',
        restaurantId: VENDOR,
        dedupKey: `no_show_payout:${id}:mismatch`,
      });
    });

    it('un échec annoncé sans montant reste un échec (rien n’est soldé)', async () => {
      const row = await sentAndApproved();
      const id = await resolveRow(row.providerPayoutId);
      expect(
        await webhook(id, {
          state: 'FAILED',
          rawStatus: 'FAILED',
          amountXaf: undefined,
          currency: undefined,
        }),
      ).toBe('APPLIED');
      expect((await rows())[0].status).toBe('FAILED');
    });

    it('erreur inattendue du prestataire à l’envoi : PENDING, jamais un 500 qui ferait croire que rien n’est parti', async () => {
      const original = provider.createPayout;
      provider.createPayout = () => Promise.reject(new Error('socket hang up'));
      try {
        const approval = await request();
        await expect(approvals.approve(approval.id, A2)).resolves.toMatchObject(
          { execution: { status: 'PENDING' } },
        );
        expect((await rows())[0].status).toBe('PENDING');
      } finally {
        provider.createPayout = original;
      }
    });

    it('statut non terminal : ignoré', async () => {
      const row = await sentAndApproved();
      const id = await resolveRow(row.providerPayoutId);
      expect(
        await webhook(id, { state: 'PENDING', rawStatus: 'ENQUEUED' }),
      ).toBe('IGNORED');
      expect((await rows())[0].status).toBe('PENDING');
    });
  });

  // ─── Liste (B-3) ───────────────────────────────────────────────────────────

  it('B-3 — la liste range l’absence en « à verser », « en cours », puis « versée »', async () => {
    const stateOf = async () =>
      (await payouts.list({})).map((s) => s.payoutState);
    expect(await stateOf()).toEqual(['DUE']);
    expect(await payouts.list({ state: 'PAID' })).toEqual([]);

    const approval = await request();
    await approvals.approve(approval.id, A2);
    expect(await stateOf()).toEqual(['IN_PROGRESS']);

    const id = await resolveRow((await rows())[0].providerPayoutId);
    await webhook(id);
    expect(await stateOf()).toEqual(['PAID']);
    const [paid] = await payouts.list({ state: 'PAID' });
    expect(paid).toMatchObject({
      settlementId: SETTLEMENT,
      vendorShareXaf: SHARE,
      restaurant: { id: VENDOR, nom: 'Chez l’Absent' },
    });
    // Le numéro complet n'est jamais renvoyé par la liste.
    expect(JSON.stringify(paid)).not.toContain('242060000081');
  });

  // ─── Grand livre ───────────────────────────────────────────────────────────

  it('grand livre : la dette FORFEIT envers le restaurant est soldée par le versement abouti', async () => {
    const approval = await request();
    await approvals.approve(approval.id, A2);
    const id = await resolveRow((await rows())[0].providerPayoutId);
    await webhook(id);

    await poster.catchUp();
    await poster.catchUp(); // idempotent

    const tx = await prisma.ledgerTransaction.findMany({
      where: { sourceEventKey: `no_show_payout:${id}:success` },
      include: { entries: true },
    });
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({
      kind: 'PAYOUT',
      sourceType: 'ReservationNoShowPayout',
      sourceId: id,
    });
    const vendorPayable = await prisma.ledgerEntry.aggregate({
      where: { account: 'vendor_payable', subjectId: VENDOR },
      _sum: { amountXaf: true },
    });
    expect(vendorPayable._sum.amountXaf).toBe(0);
  });
});

// `toSatisfy` (jest-extended) n'est pas une dépendance : défini ici.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toSatisfy(predicate: (value: unknown) => boolean): R;
    }
  }
}
expect.extend({
  toSatisfy(received: unknown, predicate: (value: unknown) => boolean) {
    const pass = predicate(received);
    const shown =
      (received as { getResponse?: () => unknown })?.getResponse?.() ??
      String(received);
    return {
      pass,
      message: () => `valeur reçue : ${JSON.stringify(shown)}`,
    };
  },
});
