import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DeliveryStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TrackingService } from './tracking.service';

/**
 * F3-12.0 (I16) — qui peut publier une position, et quand elle circule.
 *
 * Deux questions distinctes, deux réponses distinctes :
 *  - **autorisation** : seul le livreur titulaire (ou un ADMIN) publie ⇒ 403
 *    sinon, inchangé ;
 *  - **circulation** : la position n'atteint la room du client que pendant
 *    `EN_TRANSIT`. Hors de cet état, `live: false`, sans erreur.
 */
describe('TrackingService.assertCanUpdatePosition — F3-12.0', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    order: { findUnique: jest.fn() },
  };
  let service: TrackingService;

  const driver = { id: 'liv-1', role: 'LIVREUR' };
  const orderWith = (delivery: unknown) => ({
    id: 'o1',
    userId: 'client-1',
    restaurant: { ownerId: 'owner-1' },
    delivery,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        TrackingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();
    service = module.get(TrackingService);
  });

  it.each([
    [DeliveryStatus.ASSIGNER, false],
    [DeliveryStatus.ACCEPTER, false],
    [DeliveryStatus.EN_TRANSIT, true],
    [DeliveryStatus.LIVRER, false],
    [DeliveryStatus.ECHEC, false],
  ])('livreur titulaire, course %s → live = %s', async (status, live) => {
    prisma.user.findUnique.mockResolvedValue(driver);
    prisma.order.findUnique.mockResolvedValue(
      orderWith({ delivererId: 'liv-1', status }),
    );

    await expect(
      service.assertCanUpdatePosition('o1', 'fb-liv-1'),
    ).resolves.toEqual({ live });
  });

  it('un autre livreur reste refusé (403), quel que soit l’état', async () => {
    prisma.user.findUnique.mockResolvedValue(driver);
    prisma.order.findUnique.mockResolvedValue(
      orderWith({ delivererId: 'liv-2', status: DeliveryStatus.EN_TRANSIT }),
    );

    await expect(
      service.assertCanUpdatePosition('o1', 'fb-liv-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un ADMIN est autorisé, mais la règle de circulation s’applique aussi', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'a1', role: 'ADMIN' });
    prisma.order.findUnique.mockResolvedValue(
      orderWith({ delivererId: 'liv-1', status: DeliveryStatus.ACCEPTER }),
    );

    await expect(
      service.assertCanUpdatePosition('o1', 'fb-a1'),
    ).resolves.toEqual({ live: false });
  });

  it('commande sans livraison : ADMIN autorisé, rien ne circule', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'a1', role: 'ADMIN' });
    prisma.order.findUnique.mockResolvedValue(orderWith(null));

    await expect(
      service.assertCanUpdatePosition('o1', 'fb-a1'),
    ).resolves.toEqual({ live: false });
  });

  /**
   * Pendant côté LECTURE : `order:watch` ne rejoue la dernière position
   * mémorisée que si la course roule. La clé Redis survit 5 min à `LIVRER`.
   */
  describe('assertCanWatchOrder — rejouer la dernière position ?', () => {
    const client = { id: 'client-1', role: 'CLIENT' };

    it.each([
      [DeliveryStatus.EN_ATTENTE, false],
      [DeliveryStatus.ASSIGNER, false],
      [DeliveryStatus.ACCEPTER, false],
      [DeliveryStatus.EN_TRANSIT, true],
      [DeliveryStatus.LIVRER, false],
      [DeliveryStatus.ECHEC, false],
    ])('client propriétaire, course %s → live = %s', async (status, live) => {
      prisma.user.findUnique.mockResolvedValue(client);
      prisma.order.findUnique.mockResolvedValue(
        orderWith({ delivererId: 'liv-1', status }),
      );

      await expect(
        service.assertCanWatchOrder('o1', 'fb-client-1'),
      ).resolves.toEqual({ live });
    });

    it('commande sans livraison : autorisé, rien à rejouer', async () => {
      prisma.user.findUnique.mockResolvedValue(client);
      prisma.order.findUnique.mockResolvedValue(orderWith(null));

      await expect(
        service.assertCanWatchOrder('o1', 'fb-client-1'),
      ).resolves.toEqual({ live: false });
    });

    it('un tiers reste refusé (403)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'x', role: 'CLIENT' });
      prisma.order.findUnique.mockResolvedValue(
        orderWith({ delivererId: 'liv-1', status: DeliveryStatus.EN_TRANSIT }),
      );

      await expect(
        service.assertCanWatchOrder('o1', 'fb-x'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
