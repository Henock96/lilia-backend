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
});
