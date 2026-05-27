import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserCacheService } from '../auth/services/user-cache.service';

type PrismaMock = {
  user: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  loyaltyTransaction: { findMany: jest.Mock; count: jest.Mock; aggregate: jest.Mock };
  payment: { findMany: jest.Mock; count: jest.Mock; aggregate: jest.Mock };
  delivery: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
    aggregate: jest.Mock;
  };
};

function createPrismaMock(): PrismaMock {
  return {
    user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    loyaltyTransaction: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    payment: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    delivery: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
      aggregate: jest.fn(),
    },
  };
}

describe('AdminService', () => {
  let service: AdminService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: UserCacheService,
          useValue: { invalidate: jest.fn(), get: jest.fn(), set: jest.fn() },
        },
      ],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('listPayments', () => {
    it('sans status (Tous) — pas de filtre sur le where, include order.paymentMethod', async () => {
      prisma.payment.findMany.mockResolvedValue([{ id: 'p1', amount: 5000, status: 'PENDING' }]);
      prisma.payment.count.mockResolvedValue(1);

      const result = await service.listPayments(1, 20);

      expect(result).toEqual({ data: [{ id: 'p1', amount: 5000, status: 'PENDING' }], total: 1, page: 1, limit: 20 });
      const args = prisma.payment.findMany.mock.calls[0][0];
      expect(args.where).toEqual({});
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.include).toMatchObject({
        order: {
          select: {
            id: true,
            total: true,
            status: true,
            paymentMethod: true,
            user: { select: { id: true, nom: true, phone: true } },
          },
        },
      });
    });

    it('accepte un statut explicite', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.listPayments(1, 20, 'SUCCESS');

      expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({ status: 'SUCCESS' });
    });

    it('chaîne vide = vue Tous (pas de filtre)', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.listPayments(1, 20, '');

      expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('rejette un statut invalide avec BadRequestException', async () => {
      await expect(service.listPayments(1, 20, 'pending')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getPaymentsStats', () => {
    it('agrège count + sum pour pending / monthSuccess / last7DaysSuccess', async () => {
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _count: { _all: 3 }, _sum: { amount: 15000 } })
        .mockResolvedValueOnce({ _count: { _all: 42 }, _sum: { amount: 850000 } })
        .mockResolvedValueOnce({ _count: { _all: 12 }, _sum: { amount: 240000 } });

      const result = await service.getPaymentsStats();

      expect(result).toEqual({
        pending: { count: 3, totalXaf: 15000 },
        monthSuccess: { count: 42, totalXaf: 850000 },
        last7DaysSuccess: { count: 12, totalXaf: 240000 },
      });
      expect(prisma.payment.aggregate).toHaveBeenCalledTimes(3);
    });

    it('tolère _sum.amount null (aucune ligne sur la période)', async () => {
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { amount: null } })
        .mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { amount: null } })
        .mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { amount: null } });

      const result = await service.getPaymentsStats();
      expect(result.pending).toEqual({ count: 0, totalXaf: 0 });
    });
  });

  describe('getAllClients', () => {
    it('filtre uniquement les CLIENT et renvoie loyaltyPoints', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'c1', nom: 'Awa', loyaltyPoints: 120 },
      ]);
      prisma.user.count.mockResolvedValue(1);

      const result = await service.getAllClients(1, 20);

      expect(result).toEqual({ data: [{ id: 'c1', nom: 'Awa', loyaltyPoints: 120 }], total: 1, page: 1, limit: 20 });
      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ role: 'CLIENT' });
      expect(args.select.loyaltyPoints).toBe(true);
    });

    it('ajoute un filtre OR insensible à la casse quand search est fourni', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getAllClients(1, 20, 'awa');

      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        role: 'CLIENT',
        OR: [
          { nom: { contains: 'awa', mode: 'insensitive' } },
          { email: { contains: 'awa', mode: 'insensitive' } },
          { phone: { contains: 'awa', mode: 'insensitive' } },
        ],
      });
    });
  });

  describe('getClientReferral', () => {
    it('lève NotFoundException si le client est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getClientReferral('missing')).rejects.toThrow(NotFoundException);
    });

    it('agrège filleuls, conversions et bonus de parrainage', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'c1', referralCode: 'BRAZZA42', referredByCode: null,
      });
      prisma.user.count
        .mockResolvedValueOnce(3)  // totalReferrals
        .mockResolvedValueOnce(2); // convertedReferrals
      prisma.loyaltyTransaction.aggregate.mockResolvedValue({ _sum: { points: 1000 } });

      const result = await service.getClientReferral('c1');

      expect(result).toEqual({
        data: {
          referralCode: 'BRAZZA42',
          referredByCode: null,
          totalReferrals: 3,
          convertedReferrals: 2,
          referralBonusEarned: 1000,
        },
      });
      expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
        where: { referredByCode: 'BRAZZA42', referralRewarded: true },
      });
    });

    it('renvoie des compteurs à zéro si le client n\'a pas de code de parrainage', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'c1', referralCode: null, referredByCode: 'OTHER123',
      });
      prisma.loyaltyTransaction.aggregate.mockResolvedValue({ _sum: { points: null } });

      const result = await service.getClientReferral('c1');

      expect(result.data).toEqual({
        referralCode: null,
        referredByCode: 'OTHER123',
        totalReferrals: 0,
        convertedReferrals: 0,
        referralBonusEarned: 0,
      });
      expect(prisma.user.count).not.toHaveBeenCalled();
    });
  });

  describe('getClientLoyalty', () => {
    it('lève NotFoundException si le client est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getClientLoyalty('missing')).rejects.toThrow(NotFoundException);
    });

    it('retourne le solde et les transactions paginées', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'c1', loyaltyPoints: 320 });
      const txns = [{ id: 't1', points: 45, reason: '+45 pts — commande livrée', orderId: 'o1', createdAt: new Date() }];
      prisma.loyaltyTransaction.findMany.mockResolvedValue(txns);
      prisma.loyaltyTransaction.count.mockResolvedValue(1);

      const result = await service.getClientLoyalty('c1', 1, 20);

      expect(result).toEqual({
        data: { balance: 320, transactions: txns },
        total: 1,
        page: 1,
        limit: 20,
      });
      expect(prisma.loyaltyTransaction.findMany).toHaveBeenCalledWith({
        where: { userId: 'c1' },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
    });
  });

  describe('getDelivererStats', () => {
    const mockDeliverer = { id: 'd1', role: 'LIVREUR' };

    it('lève NotFoundException si le livreur est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getDelivererStats('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lève NotFoundException si l\'utilisateur n\'est pas un livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
      await expect(service.getDelivererStats('u1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('calcule stats, successRate, revenu et avgDeliveryMinutes', async () => {
      prisma.user.findUnique.mockResolvedValue(mockDeliverer);
      prisma.delivery.groupBy.mockResolvedValue([
        { status: 'LIVRER', _count: { _all: 7 } },
        { status: 'EN_TRANSIT', _count: { _all: 1 } },
        { status: 'ECHEC', _count: { _all: 2 } },
      ]);
      // Revenue : somme order.total des LIVRER
      prisma.delivery.findMany.mockResolvedValueOnce([
        { order: { total: 5000 }, pickedUpAt: new Date('2026-05-20T10:00:00Z'), deliveredAt: new Date('2026-05-20T10:30:00Z') },
        { order: { total: 4000 }, pickedUpAt: new Date('2026-05-21T12:00:00Z'), deliveredAt: new Date('2026-05-21T12:45:00Z') },
      ]);
      // last30dDeliveries count
      prisma.delivery.count.mockResolvedValueOnce(8);
      // lastDeliveryAt
      prisma.delivery.findFirst.mockResolvedValueOnce({
        deliveredAt: new Date('2026-05-21T12:45:00Z'),
      });

      const result = await service.getDelivererStats('d1');

      expect(result.data.totalDeliveries).toBe(10);
      expect(result.data.deliveredCount).toBe(7);
      expect(result.data.failedCount).toBe(2);
      expect(result.data.inProgressCount).toBe(1);
      // successRate = 7 / (7 + 2) = 0.7777... → 77.78
      expect(result.data.successRate).toBeCloseTo(77.78, 2);
      expect(result.data.totalRevenueXAF).toBe(9000);
      // avg = ((30 + 45) / 2) = 37.5 minutes
      expect(result.data.avgDeliveryMinutes).toBeCloseTo(37.5, 2);
      expect(result.data.last30dDeliveries).toBe(8);
      expect(result.data.lastDeliveryAt).toEqual(new Date('2026-05-21T12:45:00Z'));
    });

    it('renvoie des compteurs et valeurs nullables à zéro quand aucune livraison', async () => {
      prisma.user.findUnique.mockResolvedValue(mockDeliverer);
      prisma.delivery.groupBy.mockResolvedValue([]);
      prisma.delivery.findMany.mockResolvedValueOnce([]);
      prisma.delivery.count.mockResolvedValueOnce(0);
      prisma.delivery.findFirst.mockResolvedValueOnce(null);

      const result = await service.getDelivererStats('d1');

      expect(result.data).toEqual({
        totalDeliveries: 0,
        deliveredCount: 0,
        failedCount: 0,
        inProgressCount: 0,
        successRate: 0,
        totalRevenueXAF: 0,
        avgDeliveryMinutes: null,
        last30dDeliveries: 0,
        lastDeliveryAt: null,
      });
    });

    it('successRate = 100 quand 0 échec mais des livraisons réussies', async () => {
      prisma.user.findUnique.mockResolvedValue(mockDeliverer);
      prisma.delivery.groupBy.mockResolvedValue([
        { status: 'LIVRER', _count: { _all: 3 } },
      ]);
      prisma.delivery.findMany.mockResolvedValueOnce([
        { order: { total: 1000 }, pickedUpAt: null, deliveredAt: new Date() },
      ]);
      prisma.delivery.count.mockResolvedValueOnce(3);
      prisma.delivery.findFirst.mockResolvedValueOnce({ deliveredAt: new Date() });

      const result = await service.getDelivererStats('d1');

      expect(result.data.successRate).toBe(100);
      // avg = null si on n'a aucune ligne avec pickedUpAt valide
      expect(result.data.avgDeliveryMinutes).toBeNull();
    });
  });

  describe('getDelivererMissions', () => {
    const mockDeliverer = { id: 'd1', role: 'LIVREUR' };

    it('lève NotFoundException si le livreur est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getDelivererMissions('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lève NotFoundException si l\'utilisateur n\'est pas un livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
      await expect(service.getDelivererMissions('u1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('renvoie l\'historique paginé sous forme de DeliveryMissionSummary', async () => {
      prisma.user.findUnique.mockResolvedValue(mockDeliverer);
      prisma.delivery.findMany.mockResolvedValue([
        {
          id: 'dl1',
          orderId: 'o1',
          status: 'LIVRER',
          createdAt: new Date('2026-05-20T09:00:00Z'),
          pickedUpAt: new Date('2026-05-20T10:00:00Z'),
          deliveredAt: new Date('2026-05-20T10:30:00Z'),
          order: {
            total: 9000,
            restaurant: { nom: 'Chez Lilia' },
            user: { nom: 'Awa Kouyaté' },
          },
        },
      ]);
      prisma.delivery.count.mockResolvedValue(1);

      const result = await service.getDelivererMissions('d1');

      expect(result).toEqual({
        data: [
          {
            id: 'dl1',
            orderId: 'o1',
            status: 'LIVRER',
            restaurantName: 'Chez Lilia',
            clientName: 'Awa Kouyaté',
            totalXAF: 9000,
            acceptedAt: new Date('2026-05-20T10:00:00Z'),
            deliveredAt: new Date('2026-05-20T10:30:00Z'),
            createdAt: new Date('2026-05-20T09:00:00Z'),
          },
        ],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });
      const args = prisma.delivery.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ delivererId: 'd1' });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.skip).toBe(0);
      expect(args.take).toBe(20);
    });

    it('filtre par statut quand status est fourni', async () => {
      prisma.user.findUnique.mockResolvedValue(mockDeliverer);
      prisma.delivery.findMany.mockResolvedValue([]);
      prisma.delivery.count.mockResolvedValue(0);

      await service.getDelivererMissions('d1', 'LIVRER' as any);

      const args = prisma.delivery.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ delivererId: 'd1', status: 'LIVRER' });
    });

    it('applique la pagination (page 2, limit 10)', async () => {
      prisma.user.findUnique.mockResolvedValue(mockDeliverer);
      prisma.delivery.findMany.mockResolvedValue([]);
      prisma.delivery.count.mockResolvedValue(40);

      const result = await service.getDelivererMissions('d1', undefined, 2, 10);

      expect(result.meta).toEqual({ total: 40, page: 2, limit: 10, totalPages: 4 });
      const args = prisma.delivery.findMany.mock.calls[0][0];
      expect(args.skip).toBe(10);
      expect(args.take).toBe(10);
    });

    it('renvoie clientName et restaurantName null si les relations manquent', async () => {
      prisma.user.findUnique.mockResolvedValue(mockDeliverer);
      prisma.delivery.findMany.mockResolvedValue([
        {
          id: 'dl2',
          orderId: 'o2',
          status: 'EN_ATTENTE',
          createdAt: new Date('2026-05-22T08:00:00Z'),
          pickedUpAt: null,
          deliveredAt: null,
          order: {
            total: 4500,
            restaurant: null,
            user: null,
          },
        },
      ]);
      prisma.delivery.count.mockResolvedValue(1);

      const result = await service.getDelivererMissions('d1');

      expect(result.data[0]).toMatchObject({
        id: 'dl2',
        restaurantName: null,
        clientName: null,
        acceptedAt: null,
        deliveredAt: null,
      });
    });
  });
});

