import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
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
