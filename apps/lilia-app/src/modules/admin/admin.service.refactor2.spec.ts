import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
 * Tests de CARACTÉRISATION d'AdminService — clusters clients / users / reviews
 * (LIL-134). Fige le comportement avant extraction de AdminClientsService /
 * AdminUsersService / AdminReviewsService.
 */
describe('AdminService (caractérisation — clients/users/reviews)', () => {
  let service: AdminService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    // `updateUserRole` s'exécute dans une transaction depuis septembre 2026 :
    // quitter le rôle LIVREUR retire aussi la disponibilité et met le profil
    // hors service, et les deux écritures doivent réussir ou échouer ensemble.
    // Le mock exécute simplement le callback avec le même client.
    $transaction: jest.fn((cb: any) => cb(prisma)),
    driverProfile: { update: jest.fn() },
    delivery: { findFirst: jest.fn().mockResolvedValue(null) },
    loyaltyTransaction: {
      findMany: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    review: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
  };
  const userCache = {
    invalidate: jest.fn(),
    // Utilisé depuis le correctif du bannissement : propage l'échec Redis au
    // lieu de l'avaler, pour que l'admin sache que le blocage peut traîner.
    invalidateOrThrow: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        // services réels concernés par ces tests
        AdminClientsService,
        AdminUsersService,
        AdminReviewsService,
        // déjà extraits — mocks (non sollicités ici)
        { provide: AdminDeliverersService, useValue: {} },
        { provide: AdminPaymentsService, useValue: {} },
        { provide: AdminVendorsService, useValue: {} },
        { provide: AdminDashboardService, useValue: {} },
        { provide: AdminRestaurantsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: UserCacheService, useValue: userCache },
        { provide: VendorsService, useValue: {} },
        { provide: FirebaseService, useValue: {} },
        // AdminVendorsService émet `vendor.suspended` depuis août 2026 :
        // le vendeur était suspendu sans jamais en être informé.
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  // ─── Clients ───────────────────────────────────────────────────────────
  describe('getClientLoyalty', () => {
    it('404 si client introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getClientLoyalty('c1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('retourne balance + transactions paginées', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'c1',
        loyaltyPoints: 250,
      });
      prisma.loyaltyTransaction.findMany.mockResolvedValue([{ id: 't1' }]);
      prisma.loyaltyTransaction.count.mockResolvedValue(1);
      const res = await service.getClientLoyalty('c1', 1, 20);
      expect(res.data).toEqual({ balance: 250, transactions: [{ id: 't1' }] });
      expect(res.total).toBe(1);
    });
  });

  describe('getClientReferral', () => {
    it('404 si client introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getClientReferral('c1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('agrège filleuls + bonus parrainage', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'c1',
        referralCode: 'ABC',
        referredByCode: null,
      });
      prisma.user.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
      prisma.loyaltyTransaction.aggregate.mockResolvedValue({
        _sum: { points: 700 },
      });
      const res = await service.getClientReferral('c1');
      expect(res.data).toEqual({
        referralCode: 'ABC',
        referredByCode: null,
        totalReferrals: 3,
        convertedReferrals: 2,
        referralBonusEarned: 700,
      });
    });
  });

  describe('getAllClients', () => {
    it('construit le filtre de recherche OR', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'c1' }]);
      prisma.user.count.mockResolvedValue(1);
      await service.getAllClients(1, 20, 'jean');
      const where = prisma.user.findMany.mock.calls[0][0].where;
      expect(where.role).toBe('CLIENT');
      expect(where.OR).toHaveLength(3);
    });
  });

  // ─── Users ─────────────────────────────────────────────────────────────
  describe('updateUserRole', () => {
    it('BadRequest si rétrogradation d’un ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'ADMIN',
        firebaseUid: 'fb1',
      });
      await expect(
        service.updateUserRole('u1', { role: 'CLIENT' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('met à jour le rôle et invalide le cache', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'CLIENT',
        firebaseUid: 'fb1',
        // Ni boutique ni profil livreur : aucun des garde-fous de cohérence
        // ajoutés en septembre 2026 ne s'applique à ce compte.
        restaurant: null,
        driverProfile: null,
      });
      prisma.user.update.mockResolvedValue({ id: 'u1', role: 'LIVREUR' });
      const res = await service.updateUserRole('u1', {
        role: 'LIVREUR',
      } as any);
      expect(userCache.invalidateOrThrow).toHaveBeenCalledWith('fb1');
      expect(res.message).toBe('Rôle mis à jour : LIVREUR');
    });
  });

  describe('banUser', () => {
    it('BadRequest si on tente de bannir un ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'ADMIN',
        firebaseUid: 'fb1',
      });
      await expect(service.banUser('u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('écrit BLOCKED, invalide le cache et retourne le firebaseUid', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'CLIENT',
        firebaseUid: 'fb1',
      });
      const res = await service.banUser('u1', 'spam');
      // Le bannissement était un no-op : il ne touchait jamais la base.
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { statusUser: 'BLOCKED' },
      });
      expect(userCache.invalidateOrThrow).toHaveBeenCalledWith('fb1');
      expect(res).toEqual({
        firebaseUid: 'fb1',
        userId: 'u1',
        cacheInvalidated: true,
      });
    });
  });

  // ─── Reviews ───────────────────────────────────────────────────────────
  describe('deleteReview', () => {
    it('404 si avis introuvable', async () => {
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(service.deleteReview('r1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('supprime l’avis et retourne un message', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'r1' });
      const res = await service.deleteReview('r1');
      expect(prisma.review.delete).toHaveBeenCalledWith({
        where: { id: 'r1' },
      });
      expect(res).toEqual({ message: 'Avis supprimé' });
    });
  });
});
