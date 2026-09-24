import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

import { PromoService } from './promo.service';

/**
 * Code « premier achat seulement » (`firstOrderOnly`).
 *
 * La liste des statuts qui font de quelqu'un un client déjà servi était
 * recopiée inline — `PAYER, EN_PREPARATION, PRET, LIVRER` — et sautait
 * `EN_ROUTE` : un client dont la première commande était en cours de
 * livraison pouvait réutiliser un code de bienvenue. Même famille de défaut
 * que le chiffre d'affaires du 16/09/2026. Constaté le 23/09/2026 en ajoutant
 * `ACCEPTEE`, qui y serait tombé de la même façon.
 *
 * Le faux `findFirst` applique réellement le filtre de statut : le test porte
 * sur la liste utilisée, pas sur le seul fait qu'une requête soit partie.
 */
describe('PromoService.validateCode — firstOrderOnly', () => {
  function build(existingStatus: OrderStatus | null) {
    const orders = existingStatus ? [{ id: 'o1', status: existingStatus }] : [];
    const prisma = {
      promoCode: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          code: 'BIENVENUE',
          isActive: true,
          startsAt: new Date(0),
          expiresAt: null,
          maxUsageTotal: null,
          maxUsagePerUser: 1,
          firstOrderOnly: true,
          restaurantId: null,
          minOrderAmount: 0,
          discountType: 'FIXED',
          discountValue: 500,
          maxDiscount: null,
          usages: [],
          _count: { usages: 0 },
        }),
      },
      order: {
        findFirst: jest.fn(
          ({ where }: { where: { status: { in: OrderStatus[] } } }) =>
            Promise.resolve(
              orders.find((o) => where.status.in.includes(o.status)) ?? null,
            ),
        ),
      },
    };
    return new PromoService(prisma as never, {} as never);
  }

  const validate = (service: PromoService) =>
    service.validateCode('BIENVENUE', 'u1', 'r1', 5000, 1000);

  it.each<[OrderStatus]>([
    ['PAYER'],
    ['ACCEPTEE'],
    ['EN_PREPARATION'],
    ['PRET'],
    ['EN_ROUTE'],
    ['LIVRER'],
  ])(
    'refuse le code à un client qui a déjà une commande %s',
    async (status) => {
      await expect(validate(build(status))).rejects.toThrow(
        BadRequestException,
      );
    },
  );

  it.each<[OrderStatus]>([['EN_ATTENTE'], ['ANNULER']])(
    'accepte le code quand la seule commande est %s (jamais payée ou rendue)',
    async (status) => {
      await expect(validate(build(status))).resolves.toBeDefined();
    },
  );

  it('accepte le code d’un client sans commande', async () => {
    await expect(validate(build(null))).resolves.toBeDefined();
  });
});
