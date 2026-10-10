import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException } from '@nestjs/common';

import { PaymentService } from './services/payment.service';
import { PaymentEventService } from './services/payment-event.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderTransitionService } from '../orders/order-transition.service';

/**
 * Décision D-3 (10/10/2026) : **aucun article en rupture ne se paie**, chez
 * tous les vendeurs.
 *
 * Le panier et le checkout refusaient déjà un article retiré ou indisponible.
 * Restait l'intervalle entre le checkout et `POST /payments` : un vendeur qui
 * marquait un plat indisponible entre les deux laissait le client être débité,
 * puis remboursé en entier au refus. Le paiement relit donc les articles
 * avant toute demande au prestataire — et ne débite rien s'il en manque un.
 *
 * Le stock n'est pas recompté ici : il est réservé à cette commande depuis le
 * checkout. La fenêtre horaire non plus : payer deux minutes après la fin du
 * créneau d'une commande déjà acceptée au checkout n'est pas une rupture.
 */
describe('POST /payments — articles devenus indisponibles (D-3)', () => {
  let service: PaymentService;

  const prisma = {
    user: { findUnique: jest.fn() },
    orderHistory: { create: jest.fn() },
    platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    order: { findUnique: jest.fn(), updateMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    payment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    paymentEvent: { findFirst: jest.fn() },
    incident: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const provider = {
    name: 'PAWAPAY',
    supportsCollection: true,
    supportsPayout: true,
    createCollection: jest.fn(),
    getCollectionStatus: jest.fn(),
    createPayout: jest.fn(),
    getPayoutStatus: jest.fn(),
  };

  const order = (overrides: Record<string, unknown> = {}) => ({
    id: 'o1',
    userId: 'u1',
    restaurantId: 'r1',
    status: 'EN_ATTENTE',
    total: 6400,
    paymentMethod: 'MTN_MOMO',
    restaurant: { nom: 'Supérette Moungali' },
    ...overrides,
  });

  const line = (
    nom: string,
    product: { isAvailable?: boolean; deletedAt?: Date | null } = {},
    menu: { nom: string; isActive: boolean } | null = null,
  ) => ({
    product: { nom, isAvailable: true, deletedAt: null, ...product },
    menu,
  });

  const pay = () =>
    service.createPayment(
      { orderId: 'o1', phoneNumber: '061234567' } as never,
      'uid-1',
      'provider',
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    prisma.payment.count.mockResolvedValue(0);
    prisma.paymentEvent.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.orderItem.findMany.mockResolvedValue([line('Riz 5 kg')]);
    prisma.payment.create.mockResolvedValue({
      id: 'pay-1',
      orderId: 'o1',
      amount: 6400,
      currency: 'XAF',
      method: 'MTN_MOMO',
      provider: 'PAWAPAY',
      providerTransactionId: 'uuid-1',
      status: 'PENDING',
    });
    provider.createCollection.mockResolvedValue({
      accepted: true,
      duplicate: false,
      raw: {},
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderTransitionService,
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: PaymentEventService,
          useValue: {
            record: jest.fn().mockResolvedValue('evt-1'),
            setOutcome: jest.fn(),
          },
        },
        {
          provide: PaymentProviderRegistry,
          useValue: {
            currentMode: 'PAWAPAY',
            forNewTransaction: () => provider,
            forStoredProvider: () => provider,
            forPayout: () => provider,
          },
        },
        {
          provide: OutboxService,
          useValue: {
            enqueueInTransaction: jest.fn().mockResolvedValue('ob-1'),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: (_k: string, d?: unknown) => d },
        },
      ],
    }).compile();
    service = module.get(PaymentService);
  });

  const refusal = async () => {
    const error = await pay().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as {
      code: string;
      message: string;
      unavailableItems: string[];
    };
  };

  it('tous les articles disponibles : le débit part, comme avant', async () => {
    await pay();
    expect(provider.createCollection).toHaveBeenCalledTimes(1);
  });

  it('article marqué indisponible depuis le checkout : 409, AUCUN débit, aucune tentative créée', async () => {
    prisma.orderItem.findMany.mockResolvedValue([
      line('Riz 5 kg'),
      line('Lait Nido 400 g', { isAvailable: false }),
    ]);

    const response = await refusal();

    expect(response.code).toBe('ORDER_ITEMS_UNAVAILABLE');
    expect(response.unavailableItems).toEqual(['Lait Nido 400 g']);
    expect(response.message).toContain('Lait Nido 400 g');
    expect(provider.createCollection).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('article retiré du catalogue : 409', async () => {
    prisma.orderItem.findMany.mockResolvedValue([
      line('Poulet braisé', { deletedAt: new Date('2026-10-10') }),
    ]);
    expect((await refusal()).unavailableItems).toEqual(['Poulet braisé']);
  });

  it('menu désactivé : 409, nommé par le menu', async () => {
    prisma.orderItem.findMany.mockResolvedValue([
      line('Plat du jour', {}, { nom: 'Menu midi', isActive: false }),
      line('Jus', {}, { nom: 'Menu midi', isActive: false }),
    ]);
    // Un menu en deux lignes n'est cité qu'une fois.
    expect((await refusal()).unavailableItems).toEqual(['Menu midi']);
  });

  it('vaut aussi pour une commande à 0 F (payée en points) : rien n’est réglé', async () => {
    prisma.order.findUnique.mockResolvedValue(order({ total: 0 }));
    prisma.orderItem.findMany.mockResolvedValue([
      line('Croissant', { isAvailable: false }),
    ]);
    await refusal();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('la commande n’est pas touchée par le refus (décision Q-D3 a)', async () => {
    prisma.orderItem.findMany.mockResolvedValue([
      line('Lait Nido 400 g', { isAvailable: false }),
    ]);
    await refusal();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });
});
