import { OrderStatus } from '@prisma/client';

import { PaginationService } from '../../common/pagination/pagination.service';
import { OrderQueryService } from './order-query.service';

/**
 * Chaque commande renvoyée porte `allowedActions`, calculé pour le RÔLE de
 * l'appelant (règle R1). Les interfaces n'ont plus de matrice à recopier.
 *
 * ⚠️ Un vendeur ne lit jamais `GET /orders/:id` (403, réservé au client
 * propriétaire et à l'ADMIN) : c'est la LISTE `/orders/restaurant` qui doit
 * porter ses gestes.
 */
describe('OrderQueryService — allowedActions publié avec la commande', () => {
  function build(
    role: string,
    orders: Array<{ status: OrderStatus; isDelivery: boolean }>,
    acceptance = true,
  ) {
    const rows = orders.map((o, i) => ({ id: `o-${i}`, userId: 'u-1', ...o }));
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u-1', role }) },
      restaurant: { findFirst: jest.fn().mockResolvedValue({ id: 'r-1' }) },
      platformSettings: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ orderAcceptanceRequired: acceptance }),
      },
      order: {
        findMany: jest.fn().mockResolvedValue(rows),
        findUnique: jest.fn().mockResolvedValue(rows[0]),
        count: jest.fn().mockResolvedValue(rows.length),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new OrderQueryService(
      prisma as never,
      new PaginationService(),
    );
    return { service, prisma };
  }

  it('liste vendeur : Accepter / Refuser sur une commande payée', async () => {
    const { service } = build('RESTAURATEUR', [
      { status: 'PAYER', isDelivery: true },
    ]);

    const res = await service.findRestaurantOrders('fb-v');

    expect(res.data[0].allowedActions).toEqual(['ACCEPT', 'REJECT']);
  });

  it('suit l’interrupteur : « préparer » reste proposé tant que l’acceptation n’est pas en service', async () => {
    const { service } = build(
      'RESTAURATEUR',
      [{ status: 'PAYER', isDelivery: true }],
      false,
    );

    const res = await service.findRestaurantOrders('fb-v');

    expect(res.data[0].allowedActions).toContain('START_PREPARATION');
  });

  it('interrupteur lu UNE fois par requête, pas par commande', async () => {
    const { service, prisma } = build('ADMIN', [
      { status: 'PAYER', isDelivery: true },
      { status: 'PRET', isDelivery: false },
      { status: 'EN_ROUTE', isDelivery: true },
    ]);

    await service.findRestaurantOrders('fb-a');

    expect(prisma.platformSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it('détail et liste client : seul « annuler » avant paiement', async () => {
    const { service } = build('CLIENT', [
      { status: 'EN_ATTENTE', isDelivery: true },
    ]);

    const detail = await service.findOrderById('o-0', 'fb-c');
    const list = await service.findOrdersClient(1, 10, 'fb-c');

    expect(detail.allowedActions).toEqual(['CANCEL']);
    expect(list.data[0].allowedActions).toEqual(['CANCEL']);
  });

  it('aucune ligne de réglages : acceptation considérée hors service', async () => {
    const { service, prisma } = build('RESTAURATEUR', [
      { status: 'PAYER', isDelivery: true },
    ]);
    prisma.platformSettings.findUnique.mockResolvedValue(null);

    const res = await service.findRestaurantOrders('fb-v');

    expect(res.data[0].allowedActions).toContain('START_PREPARATION');
  });
});
