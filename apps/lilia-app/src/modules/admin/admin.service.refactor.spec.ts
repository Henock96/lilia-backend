import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AdminService } from './admin.service';
import { AdminDeliverersService } from './admin-deliverers.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminVendorsService } from './admin-vendors.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminUsersService } from './admin-users.service';
import { AdminReviewsService } from './admin-reviews.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminRestaurantsService } from './admin-restaurants.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserCacheService } from '../auth/services/user-cache.service';
import { VendorsService } from '../vendors/vendors.service';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Tests de CARACTÉRISATION d'AdminService — clusters livreurs / paiements /
 * vendeurs (LIL-134). Fige le comportement avant extraction de
 * AdminDeliverersService / AdminPaymentsService / AdminVendorsService.
 * Doivent rester verts après extraction (AdminService délègue).
 */
describe('AdminService (caractérisation — deliverers/payments/vendors)', () => {
  let service: AdminService;

  const prisma = {
    user: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    delivery: {
      groupBy: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
    payment: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    restaurant: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const vendorsService = { approveVendor: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        AdminDeliverersService, // services réels : AdminService y délègue
        AdminPaymentsService,
        AdminVendorsService,
        // extraits dans un autre lot — non sollicités ici
        { provide: AdminClientsService, useValue: {} },
        { provide: AdminUsersService, useValue: {} },
        { provide: AdminReviewsService, useValue: {} },
        { provide: AdminDashboardService, useValue: {} },
        { provide: AdminRestaurantsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: UserCacheService, useValue: {} },
        { provide: VendorsService, useValue: vendorsService },
        { provide: FirebaseService, useValue: {} },
      ],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  // ─── Livreurs ──────────────────────────────────────────────────────────
  describe('getDelivererStats', () => {
    it('404 si l’utilisateur n’est pas un LIVREUR', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'x', role: 'CLIENT' });
      await expect(service.getDelivererStats('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('agrège successRate, revenue et durée moyenne', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'l1', role: 'LIVREUR' });
      prisma.delivery.groupBy.mockResolvedValue([
        { status: 'LIVRER', _count: { _all: 3 } },
        { status: 'ECHEC', _count: { _all: 1 } },
      ]);
      prisma.delivery.findMany.mockResolvedValue([
        { pickedUpAt: new Date('2026-01-01T10:00:00Z'), deliveredAt: new Date('2026-01-01T10:30:00Z'), order: { total: 1000 } },
        { pickedUpAt: new Date('2026-01-01T11:00:00Z'), deliveredAt: new Date('2026-01-01T11:10:00Z'), order: { total: 2000 } },
      ]);
      prisma.delivery.count.mockResolvedValue(5);
      prisma.delivery.findFirst.mockResolvedValue({ deliveredAt: new Date('2026-01-02T00:00:00Z') });

      const { data } = await service.getDelivererStats('l1');

      expect(data.deliveredCount).toBe(3);
      expect(data.failedCount).toBe(1);
      expect(data.successRate).toBe(75); // 3/(3+1)
      expect(data.totalRevenueXAF).toBe(3000);
      expect(data.avgDeliveryMinutes).toBe(20); // (30 + 10) / 2
      expect(data.last30dDeliveries).toBe(5);
    });
  });

  describe('getDelivererMissions', () => {
    it('404 si pas LIVREUR', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getDelivererMissions('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('mappe les missions + meta', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'l1', role: 'LIVREUR' });
      prisma.delivery.findMany.mockResolvedValue([
        { id: 'd1', orderId: 'o1', status: 'LIVRER', createdAt: new Date(), pickedUpAt: new Date(), deliveredAt: new Date(), order: { total: 1500, restaurant: { nom: 'Resto' }, user: { nom: 'Client' } } },
      ]);
      prisma.delivery.count.mockResolvedValue(1);

      const res = await service.getDelivererMissions('l1', undefined, 1, 20);

      expect(res.data[0]).toMatchObject({ id: 'd1', orderId: 'o1', restaurantName: 'Resto', clientName: 'Client', totalXAF: 1500 });
      expect(res.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    });
  });

  // ─── Paiements ─────────────────────────────────────────────────────────
  describe('listPayments', () => {
    it('BadRequest si statut invalide', async () => {
      await expect(service.listPayments(1, 20, 'WRONG')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('retourne { data, total, page, limit }', async () => {
      prisma.payment.findMany.mockResolvedValue([{ id: 'p1' }]);
      prisma.payment.count.mockResolvedValue(1);
      const res = await service.listPayments(1, 20);
      expect(res).toEqual({ data: [{ id: 'p1' }], total: 1, page: 1, limit: 20 });
    });
  });

  describe('getPaymentsStats', () => {
    it('agrège pending / monthSuccess / last7DaysSuccess + délai moyen de validation', async () => {
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { amount: 5000 } })
        .mockResolvedValueOnce({ _count: { _all: 4 }, _sum: { amount: 20000 } })
        .mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { amount: 3000 } });
      // Deux paiements confirmés : 5 min et 15 min → moyenne 10 min.
      prisma.payment.findMany.mockResolvedValue([
        {
          createdAt: new Date('2026-06-01T10:00:00Z'),
          updatedAt: new Date('2026-06-01T10:05:00Z'),
        },
        {
          createdAt: new Date('2026-06-01T10:00:00Z'),
          updatedAt: new Date('2026-06-01T10:15:00Z'),
        },
      ]);

      const res = await service.getPaymentsStats();

      expect(res.pending).toEqual({ count: 2, totalXaf: 5000 });
      expect(res.monthSuccess).toEqual({ count: 4, totalXaf: 20000 });
      expect(res.last7DaysSuccess).toEqual({ count: 1, totalXaf: 3000 });
      expect(res.validationDelay).toEqual({ avgMinutes: 10, sampleCount: 2 });
    });

    it('renvoie avgMinutes null quand aucun paiement confirmé sur la fenêtre', async () => {
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { amount: null } })
        .mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { amount: null } })
        .mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { amount: null } });
      prisma.payment.findMany.mockResolvedValue([]);

      const res = await service.getPaymentsStats();

      expect(res.validationDelay).toEqual({ avgMinutes: null, sampleCount: 0 });
    });
  });

  // ─── Vendeurs ──────────────────────────────────────────────────────────
  describe('getPendingVendors', () => {
    it('retourne { data, total } des non-approuvés', async () => {
      prisma.restaurant.findMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }]);
      const res = await service.getPendingVendors();
      expect(prisma.restaurant.findMany.mock.calls[0][0].where).toEqual({ adminApproved: false });
      expect(res).toEqual({ data: [{ id: 'v1' }, { id: 'v2' }], total: 2 });
    });
  });

  describe('approveVendor', () => {
    it('délègue à VendorsService', async () => {
      vendorsService.approveVendor.mockResolvedValue({ ok: true });
      const res = await service.approveVendor('v1', 'admin1');
      expect(vendorsService.approveVendor).toHaveBeenCalledWith('v1', 'admin1');
      expect(res).toEqual({ ok: true });
    });
  });

  describe('suspendVendor', () => {
    it('404 si vendeur introuvable', async () => {
      prisma.restaurant.findUnique.mockResolvedValue(null);
      await expect(service.suspendVendor('v1', 'raison', 'a1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('BadRequest si déjà suspendu', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({ id: 'v1', isActive: false });
      await expect(service.suspendVendor('v1', 'raison', 'a1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('suspend : isActive=false + isOpen=false', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({ id: 'v1', nom: 'V', isActive: true });
      prisma.restaurant.update.mockResolvedValue({ id: 'v1', isActive: false });
      const res = await service.suspendVendor('v1', 'raison', 'a1');
      expect(prisma.restaurant.update.mock.calls[0][0].data).toEqual({ isActive: false, isOpen: false });
      expect(res.message).toBe('Vendeur suspendu');
    });
  });

  describe('activateVendor', () => {
    it('BadRequest si déjà actif', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({ id: 'v1', isActive: true });
      await expect(service.activateVendor('v1', 'a1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
