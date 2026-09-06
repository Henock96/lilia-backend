import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { OrderExpiryService } from './order-expiry.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

/**
 * Sans ce cron, une commande abandonnée avant paiement immobilisait son stock
 * indéfiniment — définitivement pour les produits `stockMode = PERMANENT`.
 */
describe('OrderExpiryService', () => {
  let service: OrderExpiryService;
  const prisma = { order: { findMany: jest.fn() } };
  const lifecycle = { expireUnpaidOrder: jest.fn() };

  const build = async (env: Record<string, number> = {}) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CronLockService,
          // Verrou neutre en test : on exécute la tâche directement.
          useValue: {
            runExclusively: jest.fn((_name, _ttl, task) => task()),
          },
        },
        OrderExpiryService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrderLifecycleService, useValue: lifecycle },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => env[k] },
        },
      ],
    }).compile();
    return module.get(OrderExpiryService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.order.findMany.mockResolvedValue([]);
    lifecycle.expireUnpaidOrder.mockResolvedValue(true);
    service = await build();
  });

  it('ne cible que les EN_ATTENTE sans paiement encaissé', async () => {
    await service.expireUnpaidOrders();

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('EN_ATTENTE');
    expect(where.Payment).toEqual({ none: { status: 'SUCCESS' } });
  });

  it('applique trois délais selon ce que le prestataire a répondu', async () => {
    service = await build({
      ORDER_PAYMENT_TIMEOUT_MINUTES: 45,
      ORDER_FAILED_PAYMENT_TIMEOUT_MINUTES: 10,
      ORDER_PENDING_PAYMENT_TIMEOUT_MINUTES: 360,
    });
    const before = Date.now();

    await service.expireUnpaidOrders();

    const after = Date.now();
    const branches = prisma.order.findMany.mock.calls[0][0].where.AND[1].OR;
    const [noPayment, failedPayment, pendingPayment] = branches;

    // Trois situations, trois branches — et elles doivent être exhaustives :
    // un paiement SUCCESS est déjà exclu plus haut, il ne reste donc que
    // « aucune ligne », « uniquement des échecs » et « au moins un PENDING ».
    expect(noPayment.Payment).toEqual({ none: {} });
    expect(failedPayment.Payment).toEqual({
      none: { status: 'PENDING' },
      some: { status: { in: ['FAILED', 'CANCELLED'] } },
    });
    expect(pendingPayment.Payment).toEqual({ some: { status: 'PENDING' } });

    // Le paiement en attente bénéficie du délai le plus long : en mode MANUAL
    // c'est peut-être la confirmation admin qui traîne, pas le client.
    expect(pendingPayment.createdAt.lt.getTime()).toBeLessThan(
      noPayment.createdAt.lt.getTime(),
    );

    // Fix S-6 : un refus définitif rend le stock le plus vite. Le prestataire
    // a tranché — attendre les 45 min du cas « le client hésite encore »
    // n'immobilisait le stock que pour rien.
    expect(failedPayment.createdAt.lt.getTime()).toBeGreaterThan(
      noPayment.createdAt.lt.getTime(),
    );

    // Le cutoff est calculé PENDANT l'appel : il vaut `Date.now() − 45 min`
    // pour un `Date.now()` compris entre `before` et `after`. On encadre donc
    // au lieu de comparer à `before` seul.
    //
    // La version précédente affirmait `before − cutoff >= 45 min`, ce qui
    // n'est vrai que si les deux horodatages tombent dans la MÊME
    // milliseconde : le test passait par chance en exécution normale et
    // échouait sous `--coverage`, plus lent à cause de l'instrumentation.
    const cutoff = noPayment.createdAt.lt.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - 45 * 60_000);
    expect(cutoff).toBeLessThanOrEqual(after - 45 * 60_000);
  });

  it('épargne les précommandes dont l’échéance n’est pas passée', async () => {
    await service.expireUnpaidOrders();

    const scheduled = prisma.order.findMany.mock.calls[0][0].where.AND[0].OR;
    expect(scheduled[0]).toEqual({ scheduledFor: null });
    expect(scheduled[1].scheduledFor.lt).toBeInstanceOf(Date);
  });

  it('poursuit le lot si une commande échoue', async () => {
    prisma.order.findMany.mockResolvedValue([
      { id: 'o1' },
      { id: 'o2' },
      { id: 'o3' },
    ]);
    lifecycle.expireUnpaidOrder
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce(true);

    await expect(service.expireUnpaidOrders()).resolves.toBeUndefined();
    expect(lifecycle.expireUnpaidOrder).toHaveBeenCalledTimes(3);
  });
});
