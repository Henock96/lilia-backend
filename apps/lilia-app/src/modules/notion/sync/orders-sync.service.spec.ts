import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotionClient } from '../notion.client';
import { NotionConfig } from '../notion.config';
import { OrdersSyncService } from './orders-sync.service';

describe('OrdersSyncService', () => {
  let service: OrdersSyncService;
  let notion: jest.Mocked<NotionClient>;
  let notionConfig: { getDbId: jest.Mock };
  let prisma: { order: { findUnique: jest.Mock; findMany: jest.Mock } };

  beforeEach(async () => {
    notion = {
      exec: jest.fn().mockResolvedValue({ id: 'page_xyz' }),
      findPageByPrismaId: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<NotionClient>;
    notionConfig = { getDbId: jest.fn().mockReturnValue('ds_orders') };
    prisma = {
      order: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersSyncService,
        { provide: NotionClient, useValue: notion },
        { provide: NotionConfig, useValue: notionConfig },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(OrdersSyncService);
  });

  it('skip si data source id absent', async () => {
    notionConfig.getDbId.mockReturnValue(undefined);
    await service.syncOne('order_1');
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(notion.exec).not.toHaveBeenCalled();
  });

  it('skip si order introuvable', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    await service.syncOne('order_missing');
    expect(notion.exec).not.toHaveBeenCalled();
  });

  it('crée une page si pas de match Prisma ID', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order_1',
      userId: 'u',
      status: 'PAYER',
      paymentMethod: 'MTN_MOMO',
      total: 1000,
      subTotal: 800,
      deliveryFee: 200,
      serviceFee: 0,
      discountAmount: 0,
      createdAt: new Date(),
      paidAt: null,
      contactPhone: null,
      items: [],
      restaurant: { nom: 'Test' },
      user: null,
    });
    notion.findPageByPrismaId.mockResolvedValue(null);

    await service.syncOne('order_1');

    expect(notion.findPageByPrismaId).toHaveBeenCalledWith(
      'ds_orders',
      expect.any(String),
      'order_1',
    );
    expect(notion.exec).toHaveBeenCalledTimes(1);
    expect(notion.exec.mock.calls[0][0]).toContain('createOrder');
  });

  it('update la page existante si match Prisma ID', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order_1',
      userId: 'u',
      status: 'PAYER',
      paymentMethod: 'MTN_MOMO',
      total: 1000,
      subTotal: 800,
      deliveryFee: 200,
      serviceFee: 0,
      discountAmount: 0,
      createdAt: new Date(),
      paidAt: null,
      contactPhone: null,
      items: [],
      restaurant: { nom: 'Test' },
      user: null,
    });
    notion.findPageByPrismaId.mockResolvedValue('page_existing');

    await service.syncOne('order_1');

    expect(notion.exec.mock.calls[0][0]).toContain('updateOrder');
  });
});
