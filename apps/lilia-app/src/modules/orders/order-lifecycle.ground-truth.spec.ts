import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderStateMachine } from './order-state.machine';

/**
 * Un statut de commande doit décrire quelque chose qui a réellement eu lieu
 * (audit post-correction, B-1).
 *
 * Ces règles ne peuvent pas vivre dans `ORDER_TRANSITION_MATRIX` : celle-ci
 * dit *qui* a le droit de faire une transition, pas si le terrain la soutient.
 * « Le vendeur peut clôturer une commande à emporter » et « il ne peut pas
 * clôturer une livraison » sont la **même** case de la matrice — seul
 * `Order.isDelivery` les sépare.
 *
 * Elles sont testées ici avec la vraie `OrderStateMachine` : mocker la machine
 * laisserait passer une matrice devenue incohérente avec les gardes, et c'est
 * précisément le couple des deux qui porte la règle.
 */
describe('OrderLifecycleService — le statut ne ment pas sur le terrain', () => {
  const VENDOR = { id: 'u-vendor', role: 'RESTAURATEUR', firebaseUid: 'fb-v' };
  const ADMIN = { id: 'u-admin', role: 'ADMIN', firebaseUid: 'fb-a' };

  function buildService(overrides: {
    order: Partial<{ status: OrderStatus; isDelivery: boolean }>;
    user?: typeof VENDOR;
    deliveryEnTransit?: boolean;
  }) {
    const order = {
      id: 'o-1',
      userId: 'u-client',
      restaurantId: 'r-1',
      status: 'PRET' as OrderStatus,
      isDelivery: true,
      subTotal: 5000,
      total: 5400,
      restaurant: { nom: 'Chez Awa', ownerId: VENDOR.id },
      items: [],
      ...overrides.order,
    };

    const tx = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(order),
      },
    };

    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(overrides.user ?? VENDOR),
      },
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      delivery: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            overrides.deliveryEnTransit ? { id: 'd-1' } : null,
          ),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    const eventEmitter = { emit: jest.fn() };
    const loyalty = { awardForDeliveredOrder: jest.fn().mockResolvedValue(1) };
    const refunds = { openForCancelledOrder: jest.fn() };

    const service = new OrderLifecycleService(
      prisma as any,
      eventEmitter as any,
      new OrderStateMachine(),
      { restoreInTransaction: jest.fn() } as any,
      loyalty as any,
      refunds as any,
    );

    return { service, prisma, eventEmitter, loyalty, order };
  }

  describe('EN_ROUTE — « votre livreur est en chemin »', () => {
    it("refuse le passage quand aucun livreur n'a récupéré la commande", async () => {
      // Le cas de B-1 vu par l'ADMIN, seul acteur que la matrice autorise
      // encore : sans course en cours, la notification serait un mensonge.
      const { service, eventEmitter } = buildService({
        order: { status: 'PRET' },
        user: ADMIN,
        deliveryEnTransit: false,
      });

      await expect(
        service.updateOrderStatusByRestaurateur(
          'o-1',
          ADMIN.firebaseUid,
          'EN_ROUTE',
        ),
      ).rejects.toThrow(BadRequestException);

      // Le point qui compte : le client n'a rien reçu.
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('accepte le passage quand une course est effectivement en transit', async () => {
      const { service, eventEmitter } = buildService({
        order: { status: 'PRET' },
        user: ADMIN,
        deliveryEnTransit: true,
      });

      await service.updateOrderStatusByRestaurateur(
        'o-1',
        ADMIN.firebaseUid,
        'EN_ROUTE',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.status.updated',
        expect.objectContaining({ newStatus: 'EN_ROUTE' }),
      );
    });
  });

  describe('PRET → LIVRER — le raccourci du comptoir', () => {
    it('laisse le vendeur clôturer une commande à emporter', async () => {
      const { service, loyalty } = buildService({
        order: { status: 'PRET', isDelivery: false },
      });

      await service.updateOrderStatusByRestaurateur(
        'o-1',
        VENDOR.firebaseUid,
        'LIVRER',
      );

      // La remise au comptoir est une livraison comme une autre du point de
      // vue du client : ses points doivent être crédités.
      expect(loyalty.awardForDeliveredOrder).toHaveBeenCalled();
    });

    it('refuse au vendeur de clôturer une commande à livrer jamais partie', async () => {
      // Sans cette garde, le raccourci comptoir devient un moyen de marquer
      // « livrée » — et de créditer les points — une commande que le client
      // n'a jamais reçue.
      const { service, loyalty, eventEmitter } = buildService({
        order: { status: 'PRET', isDelivery: true },
      });

      await expect(
        service.updateOrderStatusByRestaurateur(
          'o-1',
          VENDOR.firebaseUid,
          'LIVRER',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(loyalty.awardForDeliveredOrder).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it("laisse l'ADMIN clôturer une livraison déjà en route", async () => {
      // Contre-épreuve : la garde vise le raccourci depuis PRET, pas la
      // clôture d'une course qui a bien eu lieu et que le livreur n'a pas
      // enregistrée.
      const { service, loyalty } = buildService({
        order: { status: 'EN_ROUTE', isDelivery: true },
        user: ADMIN,
      });

      await service.updateOrderStatusByRestaurateur(
        'o-1',
        ADMIN.firebaseUid,
        'LIVRER',
      );

      expect(loyalty.awardForDeliveredOrder).toHaveBeenCalled();
    });
  });
});
