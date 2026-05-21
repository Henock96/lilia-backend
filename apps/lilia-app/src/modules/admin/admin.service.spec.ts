import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../../prisma/prisma.service';

type PrismaMock = {
  user: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  loyaltyTransaction: { findMany: jest.Mock; count: jest.Mock; aggregate: jest.Mock };
  payment: { findMany: jest.Mock; count: jest.Mock };
};

function createPrismaMock(): PrismaMock {
  return {
    user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    loyaltyTransaction: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    payment: { findMany: jest.fn(), count: jest.fn() },
  };
}

describe('AdminService', () => {
  let service: AdminService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getPendingPayments', () => {
    it('filtre sur PENDING par défaut, avec la commande et le client liés', async () => {
      prisma.payment.findMany.mockResolvedValue([{ id: 'p1', amount: 5000, status: 'PENDING' }]);
      prisma.payment.count.mockResolvedValue(1);

      const result = await service.getPendingPayments(1, 20);

      expect(result).toEqual({ data: [{ id: 'p1', amount: 5000, status: 'PENDING' }], total: 1, page: 1, limit: 20 });
      const args = prisma.payment.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ status: 'PENDING' });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.include).toMatchObject({
        order: {
          select: {
            id: true,
            total: true,
            status: true,
            user: { select: { id: true, nom: true, phone: true } },
          },
        },
      });
    });

    it('accepte un statut explicite', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.getPendingPayments(1, 20, 'SUCCESS');

      expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({ status: 'SUCCESS' });
    });

    it('rejette un statut invalide avec BadRequestException', async () => {
      await expect(service.getPendingPayments(1, 20, 'pending')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
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
});

