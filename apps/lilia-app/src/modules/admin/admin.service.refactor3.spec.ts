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
 * Tests de CARACTÉRISATION d'AdminService — clusters dashboard / restaurants
 * (LIL-134). Fige le comportement avant extraction de AdminDashboardService /
 * AdminRestaurantsService.
 */
describe('AdminService (caractérisation — dashboard/restaurants)', () => {
  let service: AdminService;

  const txCtx = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    restaurant: { findUnique: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    user: { groupBy: jest.fn() },
    order: { aggregate: jest.fn(), groupBy: jest.fn(), count: jest.fn() },
    restaurant: { groupBy: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(async (cb: any) => cb(txCtx)),
  };
  const firebaseService = { createUser: jest.fn(), deleteUserSafe: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        AdminDashboardService, // réels concernés
        AdminRestaurantsService,
        { provide: AdminDeliverersService, useValue: {} },
        { provide: AdminPaymentsService, useValue: {} },
        { provide: AdminVendorsService, useValue: {} },
        { provide: AdminClientsService, useValue: {} },
        { provide: AdminUsersService, useValue: {} },
        { provide: AdminReviewsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: UserCacheService, useValue: {} },
        { provide: VendorsService, useValue: {} },
        { provide: FirebaseService, useValue: firebaseService },
      ],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  describe('getDashboardStats', () => {
    it('agrège users/revenue/orders/restaurants', async () => {
      prisma.user.groupBy.mockResolvedValue([
        { role: 'CLIENT', _count: { role: 10 } },
        { role: 'LIVREUR', _count: { role: 3 } },
      ]);
      prisma.order.aggregate
        .mockResolvedValueOnce({ _sum: { total: 100000 } }) // total
        .mockResolvedValueOnce({ _sum: { total: 5000 } }); // today
      prisma.order.groupBy
        .mockResolvedValueOnce([{ status: 'LIVRER', _count: { status: 7 } }]) // byStatus
        .mockResolvedValueOnce([]); // weekly
      prisma.restaurant.groupBy.mockResolvedValue([
        { isActive: true, _count: { isActive: 4 } },
        { isActive: false, _count: { isActive: 1 } },
      ]);
      prisma.order.count.mockResolvedValue(2);

      const res = await service.getDashboardStats();

      expect(res.users).toEqual({ byRole: { CLIENT: 10, LIVREUR: 3 }, total: 13 });
      expect(res.revenue).toEqual({ total: 100000, today: 5000 });
      expect(res.orders.byStatus).toEqual({ LIVRER: 7 });
      expect(res.orders.pendingCount).toBe(2);
      expect(res.restaurants).toEqual({ active: 4, inactive: 1 });
    });
  });

  describe('createRestaurantWithOwner', () => {
    const dto = {
      email: 'o@x.cg', password: 'secret123', nom: 'Owner', phone: '06',
      restaurantNom: 'Resto', restaurantAdresse: 'Rue 1', restaurantPhone: '07',
    } as any;

    it('BadRequest si l’email Firebase existe déjà', async () => {
      firebaseService.createUser.mockRejectedValue({ code: 'auth/email-already-exists' });
      await expect(service.createRestaurantWithOwner(dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('happy : crée owner + restaurant (RESTAURANT auto-approuvé)', async () => {
      firebaseService.createUser.mockResolvedValue('fb-uid');
      txCtx.user.findUnique.mockResolvedValue(null);
      txCtx.user.create.mockResolvedValue({ id: 'u1', role: 'RESTAURATEUR' });
      txCtx.restaurant.findUnique.mockResolvedValue(null);
      txCtx.restaurant.create.mockResolvedValue({ id: 'r1', adminApproved: true });

      const res = await service.createRestaurantWithOwner(dto);

      expect(txCtx.restaurant.create.mock.calls[0][0].data.adminApproved).toBe(true);
      expect(res.message).toBe('Restaurant et propriétaire créés avec succès');
    });

    it('rollback Firebase si la transaction échoue', async () => {
      firebaseService.createUser.mockResolvedValue('fb-uid');
      txCtx.user.findUnique.mockResolvedValue(null);
      txCtx.user.create.mockResolvedValue({ id: 'u1', role: 'RESTAURATEUR' });
      txCtx.restaurant.findUnique.mockResolvedValue({ id: 'existing' }); // déjà un resto → throw

      await expect(service.createRestaurantWithOwner(dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(firebaseService.deleteUserSafe).toHaveBeenCalledWith('fb-uid');
    });
  });

  describe('toggleRestaurantActive', () => {
    it('404 si restaurant introuvable', async () => {
      prisma.restaurant.findUnique.mockResolvedValue(null);
      await expect(
        service.toggleRestaurantActive('r1', true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('désactive : isActive=false + isOpen=false', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({ id: 'r1', isOpen: true });
      prisma.restaurant.update.mockResolvedValue({ id: 'r1', isActive: false });
      const res = await service.toggleRestaurantActive('r1', false);
      expect(prisma.restaurant.update.mock.calls[0][0].data).toEqual({ isActive: false, isOpen: false });
      expect(res.message).toBe('Restaurant désactivé');
    });
  });
});
