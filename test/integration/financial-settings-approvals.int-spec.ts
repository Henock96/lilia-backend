import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';

import { AdminAuditService } from '../../apps/lilia-app/src/modules/admin-audit/admin-audit.service';
import { ApprovalsService } from '../../apps/lilia-app/src/modules/approvals/approvals.service';
import { SettingsApprovalsService } from '../../apps/lilia-app/src/modules/approvals/settings-approvals.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { RefundExecutionService } from '../../apps/lilia-app/src/modules/refunds/refund-execution.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';

/**
 * **R-09 — réglages financiers à deux administrateurs (PostgreSQL réel).**
 *
 * Un taux qui fixe de l'argent ne change qu'à l'approbation d'un second
 * administrateur, et seulement s'il n'a pas bougé depuis la demande.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Réglages financiers à deux administrateurs (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let settings: PlatformSettingsService;
    let approvals: ApprovalsService;
    let requests: SettingsApprovalsService;

    const A1 = 'fs-admin-1';
    const A2 = 'fs-admin-2';
    const VENDOR = 'fs-vendor';

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();
      settings = new PlatformSettingsService(prisma as never);
      approvals = new ApprovalsService(
        prisma as never,
        new AdminAuditService(prisma as never),
        new OutboxService(prisma as never),
        new RefundExecutionService(
          prisma as never,
          { currentMode: 'MANUAL', forPayout: () => null } as never,
          new PaymentEventService(prisma as never),
        ),
        { invalidate: async () => undefined } as never,
        new EventEmitter2(),
        new RefundsService(prisma as never),
        settings,
      );
      requests = new SettingsApprovalsService(
        prisma as never,
        approvals,
        settings,
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "FinancialApproval", "AdminAuditLog", "OutboxEvent",
                     "PlatformSettings", "DeliveryTariff", "Restaurant", "User"
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
            firebaseUid: 'fb-fs-1',
            email: 'fs1@test.local',
            role: 'ADMIN',
            adminCapabilities: [...all],
          },
          {
            id: A2,
            firebaseUid: 'fb-fs-2',
            email: 'fs2@test.local',
            role: 'ADMIN',
            adminCapabilities: [...all],
          },
          {
            id: 'fs-owner',
            firebaseUid: 'fb-fs-o',
            email: 'fso@test.local',
            role: 'RESTAURATEUR',
          },
        ],
      });
      await prisma.platformSettings.create({
        data: {
          id: 'singleton',
          serviceFeePercent: 15,
          loyaltyPointValueXaf: 50,
        },
      });
      await prisma.restaurant.create({
        data: {
          id: VENDOR,
          nom: 'Épicerie Deux Signatures',
          adresse: 'Poto-Poto',
          phone: '060000090',
          ownerId: 'fs-owner',
          vendorType: 'GROCERY',
          commissionPercent: null,
        },
      });
      settings.invalidateCache();
    });

    const loaded = async () =>
      (await settings.readFreshSettings()).updatedAt.toISOString();

    describe('réglages de plateforme', () => {
      it('la demande ne change rien : elle attend un second administrateur', async () => {
        const res = await requests.requestPlatformChange(
          {
            serviceFeePercent: 12,
            groceryServiceFeeBps: 500,
            expectedUpdatedAt: await loaded(),
          },
          A1,
        );
        expect(res.approvalRequired).toBe(true);
        expect(res.approval).toMatchObject({
          kind: 'PLATFORM_SETTINGS_CHANGE',
          refId: 'platform-settings',
          status: 'PENDING',
          payload: {
            changes: { serviceFeePercent: 12, groceryServiceFeeBps: 500 },
            before: { serviceFeePercent: 15, groceryServiceFeeBps: null },
          },
        });
        const row = await prisma.platformSettings.findUniqueOrThrow({
          where: { id: 'singleton' },
        });
        expect(row.serviceFeePercent).toBe(15);
        expect(row.groceryServiceFeeBps).toBeNull();
        // Le second administrateur est prévenu (outbox, dans la transaction).
        expect(await prisma.outboxEvent.count()).toBe(1);
      });

      it('l’approbation par un autre administrateur applique, consomme et journalise', async () => {
        const { approval } = await requests.requestPlatformChange(
          { serviceFeePercent: 12, expectedUpdatedAt: await loaded() },
          A1,
        );
        // Lecture en cache avant : l'approbation doit la périmer.
        expect((await settings.getSettings()).serviceFeePercent).toBe(15);

        await approvals.approve(approval.id, A2);

        expect((await settings.getSettings()).serviceFeePercent).toBe(12);
        const decided = await prisma.financialApproval.findUniqueOrThrow({
          where: { id: approval.id },
        });
        expect(decided).toMatchObject({ status: 'CONSUMED', approvedBy: A2 });
        const log = await prisma.adminAuditLog.findFirstOrThrow({
          where: { action: 'PLATFORM_SETTINGS_CHANGED' },
        });
        expect(log.actorId).toBe(A1);
        expect(log.metadata).toMatchObject({
          serviceFeePercent: { before: 15, after: 12 },
          approvalId: approval.id,
          approvedBy: A2,
        });
      });

      it('le demandeur ne peut pas approuver sa propre demande', async () => {
        const { approval } = await requests.requestPlatformChange(
          { serviceFeePercent: 12, expectedUpdatedAt: await loaded() },
          A1,
        );
        await expect(approvals.approve(approval.id, A1)).rejects.toMatchObject({
          response: { code: 'APPROVAL_SELF_FORBIDDEN' },
        });
        expect((await settings.readFreshSettings()).serviceFeePercent).toBe(15);
      });

      it('un taux qui a bougé depuis la demande : 409, rien n’est appliqué, la demande reste ouverte', async () => {
        const { approval } = await requests.requestPlatformChange(
          { serviceFeePercent: 12, expectedUpdatedAt: await loaded() },
          A1,
        );
        await prisma.platformSettings.update({
          where: { id: 'singleton' },
          data: { serviceFeePercent: 14 },
        });

        await expect(approvals.approve(approval.id, A2)).rejects.toMatchObject({
          response: { code: 'APPROVAL_STALE', fields: ['serviceFeePercent'] },
        });
        expect((await settings.readFreshSettings()).serviceFeePercent).toBe(14);
        // Le conflit est levé DANS la transaction : l'approbation n'est ni
        // consommée ni marquée approuvée (piège R-01).
        const still = await prisma.financialApproval.findUniqueOrThrow({
          where: { id: approval.id },
        });
        expect(still).toMatchObject({ status: 'PENDING', approvedBy: null });
      });

      it('un réglage non financier changé entre-temps ne périme pas la demande', async () => {
        const { approval } = await requests.requestPlatformChange(
          { serviceFeePercent: 12, expectedUpdatedAt: await loaded() },
          A1,
        );
        await settings.updateSettings({ maintenanceMessage: 'Retour à 14 h' });
        await approvals.approve(approval.id, A2);
        const row = await settings.readFreshSettings();
        expect(row).toMatchObject({
          serviceFeePercent: 12,
          maintenanceMessage: 'Retour à 14 h',
        });
      });

      it('une seule demande financière en attente à la fois', async () => {
        const at = await loaded();
        await requests.requestPlatformChange(
          { serviceFeePercent: 12, expectedUpdatedAt: at },
          A1,
        );
        await expect(
          requests.requestPlatformChange(
            { loyaltyPointValueXaf: 40, expectedUpdatedAt: at },
            A2,
          ),
        ).rejects.toMatchObject({
          response: { code: 'APPROVAL_ALREADY_PENDING' },
        });
      });

      it('formulaire périmé : la demande est refusée (SETTINGS_STALE)', async () => {
        await expect(
          requests.requestPlatformChange(
            {
              serviceFeePercent: 12,
              expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
            },
            A1,
          ),
        ).rejects.toMatchObject({ response: { code: 'SETTINGS_STALE' } });
      });

      it('aucune valeur différente : 400, aucune demande ouverte', async () => {
        await expect(
          requests.requestPlatformChange(
            { serviceFeePercent: 15, expectedUpdatedAt: await loaded() },
            A1,
          ),
        ).rejects.toMatchObject({ status: 400 });
        expect(await prisma.financialApproval.count()).toBe(0);
      });

      it('la bascule de tarification sans grille publiée est refusée dès la demande', async () => {
        await expect(
          requests.requestPlatformChange(
            {
              deliveryPricingMode: 'PLATFORM',
              expectedUpdatedAt: await loaded(),
            },
            A1,
          ),
        ).rejects.toMatchObject({
          response: { code: 'DELIVERY_TARIFF_NOT_PUBLISHED' },
        });
      });

      it('deux approbations simultanées : un seul changement appliqué', async () => {
        const { approval } = await requests.requestPlatformChange(
          { loyaltyPointValueXaf: 40, expectedUpdatedAt: await loaded() },
          A1,
        );
        const results = await Promise.allSettled([
          approvals.approve(approval.id, A2),
          approvals.approve(approval.id, A2),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(
          await prisma.adminAuditLog.count({
            where: { action: 'PLATFORM_SETTINGS_CHANGED' },
          }),
        ).toBe(1);
        expect((await settings.readFreshSettings()).loyaltyPointValueXaf).toBe(
          40,
        );
      });
    });

    describe('commission par vendeur', () => {
      it('demande puis approbation : la commission change et le changement est journalisé', async () => {
        const res = await requests.requestVendorCommissionChange(
          VENDOR,
          { commissionPercent: 7.5 },
          A1,
        );
        expect(res.approval).toMatchObject({
          kind: 'VENDOR_COMMISSION_CHANGE',
          refId: VENDOR,
          payload: {
            commissionPercent: 7.5,
            before: null,
            vendorName: 'Épicerie Deux Signatures',
          },
        });
        expect(
          (await prisma.restaurant.findUniqueOrThrow({ where: { id: VENDOR } }))
            .commissionPercent,
        ).toBeNull();

        await approvals.approve(res.approval.id, A2);

        expect(
          (await prisma.restaurant.findUniqueOrThrow({ where: { id: VENDOR } }))
            .commissionPercent,
        ).toBe(7.5);
        const log = await prisma.adminAuditLog.findFirstOrThrow({
          where: { action: 'VENDOR_COMMISSION_CHANGED' },
        });
        expect(log).toMatchObject({ actorId: A1, targetId: VENDOR });
        expect(log.metadata).toMatchObject({
          from: null,
          to: 7.5,
          approvedBy: A2,
        });
      });

      it('null rend le vendeur au taux plateforme', async () => {
        await prisma.restaurant.update({
          where: { id: VENDOR },
          data: { commissionPercent: 9 },
        });
        const { approval } = await requests.requestVendorCommissionChange(
          VENDOR,
          { commissionPercent: null },
          A1,
        );
        await approvals.approve(approval.id, A2);
        expect(
          (await prisma.restaurant.findUniqueOrThrow({ where: { id: VENDOR } }))
            .commissionPercent,
        ).toBeNull();
      });

      it('une commission qui a bougé depuis la demande : 409, rien n’est appliqué', async () => {
        const { approval } = await requests.requestVendorCommissionChange(
          VENDOR,
          { commissionPercent: 7.5 },
          A1,
        );
        await prisma.restaurant.update({
          where: { id: VENDOR },
          data: { commissionPercent: 9 },
        });
        await expect(approvals.approve(approval.id, A2)).rejects.toMatchObject({
          response: { code: 'APPROVAL_STALE' },
        });
        expect(
          (await prisma.restaurant.findUniqueOrThrow({ where: { id: VENDOR } }))
            .commissionPercent,
        ).toBe(9);
      });

      it('vendeur inconnu : 404 ; même valeur : 400', async () => {
        await expect(
          requests.requestVendorCommissionChange(
            'nope',
            { commissionPercent: 5 },
            A1,
          ),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          requests.requestVendorCommissionChange(
            VENDOR,
            { commissionPercent: null },
            A1,
          ),
        ).rejects.toMatchObject({ status: 400 });
      });
    });
  },
);
