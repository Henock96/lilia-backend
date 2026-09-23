import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { OrdersController } from './orders.controller';

/**
 * Routes d'acceptation vendeur (Phase 3, F3-01) : forme HTTP, rôles, et
 * délégation. Le contrôle de PROPRIÉTÉ vit dans le service (testé dans
 * `order-acceptance.spec.ts`) ; ici on fixe que la porte n'est ouverte qu'aux
 * deux rôles qui peuvent agir sur une commande de vendeur.
 */
describe('OrdersController — accepter / refuser (F3-01)', () => {
  const proto = OrdersController.prototype as unknown as Record<string, object>;

  it.each([
    ['acceptOrder', ':id/accept'],
    ['rejectOrder', ':id/reject'],
  ])('%s : POST %s, réservé à RESTAURATEUR et ADMIN', (handlerName, path) => {
    const handler = proto[handlerName];
    expect(handler).toBeDefined();
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
      'RESTAURATEUR',
      'ADMIN',
    ]);
  });

  it('délègue au service avec l’identité Firebase de l’appelant', async () => {
    const ordersService = {
      acceptOrder: jest.fn().mockResolvedValue({ id: 'o1' }),
      rejectOrder: jest.fn().mockResolvedValue({ id: 'o1' }),
    };
    const controller = new OrdersController(
      ordersService as never,
      {} as never,
    );
    const fbUser = { uid: 'fb-v' } as never;

    await controller.acceptOrder('o1', fbUser, { prepMinutes: 20 });
    await controller.rejectOrder('o1', fbUser, {
      reason: 'TOO_BUSY',
      note: 'rush',
    });

    expect(ordersService.acceptOrder).toHaveBeenCalledWith('o1', 'fb-v', 20);
    expect(ordersService.rejectOrder).toHaveBeenCalledWith('o1', 'fb-v', {
      reason: 'TOO_BUSY',
      note: 'rush',
    });
  });
});
