import { BadRequestException, ConflictException } from '@nestjs/common';

import { RefundExecutionService } from './refund-execution.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';
import { PaymentEventService } from '../payments/services/payment-event.service';

/**
 * Exécution du virement de remboursement au client.
 *
 * ## Ce qui existait, et ce qui manquait
 *
 * `Refund` était un **registre déclaratif** : un administrateur passait le
 * statut à `COMPLETED` à la main. Un remboursement « terminé » en base ne
 * prouvait donc rien — c'était le dernier mouvement d'argent de la plateforme
 * sans trace prestataire, alors que le rail existait déjà et servait aux
 * vendeurs.
 *
 * ## Les invariants que ces tests figent
 *
 * Ils sont ceux du reversement vendeur, transposés — délibérément, parce qu'un
 * second modèle d'idempotence finirait par diverger du premier :
 *
 *  · l'identifiant prestataire est **généré et persisté avant l'appel réseau**,
 *    ce qui rend une reprise sûre (`DUPLICATE_IGNORED` au lieu d'un 2ᵉ virement) ;
 *  · la destination vient de `Payment.phoneNumber` et **jamais** d'une saisie ;
 *  · on ne rembourse pas une commande dont le vendeur a déjà été payé ;
 *  · un prestataire injoignable laisse la ligne en `PROCESSING`, jamais en échec.
 */
describe('RefundExecutionService', () => {
  const ADMIN = 'admin-1';

  const buildRefund = (over: Record<string, unknown> = {}) => ({
    id: 'ref-1',
    orderId: 'o1',
    amount: 6400,
    status: 'PENDING',
    reasonCode: 'ORDER_CANCELLED',
    bearer: 'PLATFORM',
    provider: null,
    providerRefundId: null,
    payment: {
      id: 'pay-1',
      status: 'SUCCESS',
      phoneNumber: '242060000001',
      method: 'MTN_MOMO',
    },
    order: { id: 'o1', status: 'ANNULER', payout: null },
    ...over,
  });

  const make = (
    refund: unknown,
    providerOver: Record<string, unknown> = {},
    /** Reversement relu SOUS le verrou de la commande (fix F-04). */
    payoutUnderLock: { status: string } | null = null,
  ) => {
    const createPayout = jest.fn().mockResolvedValue({
      accepted: true,
      duplicate: false,
      raw: {},
      ...providerOver,
    });
    const prisma = {
      refund: {
        findUnique: jest.fn().mockResolvedValue(refund),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      restaurantPayout: {
        findUnique: jest.fn().mockResolvedValue(payoutUnderLock),
      },
      // Verrou de la ligne `Order` (fix F-04).
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'ANNULER' }]),
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const registry = {
      currentMode: 'PAWAPAY',
      forPayout: () => ({ name: 'PAWAPAY', createPayout, ...providerOver }),
    };
    const events = { record: jest.fn().mockResolvedValue('evt-1') };
    const service = new RefundExecutionService(
      prisma as unknown as PrismaService,
      registry as unknown as PaymentProviderRegistry,
      events as unknown as PaymentEventService,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return { service, prisma, createPayout };
  };

  it('vire sur le numéro qui a PAYÉ, jamais sur une saisie', async () => {
    // Rembourser ailleurs que sur l'origine des fonds transformerait cette file
    // en outil de détournement : annuler une commande, désigner un autre numéro.
    const { service, createPayout } = make(buildRefund());

    await service.execute('ref-1', ADMIN);

    expect(createPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '242060000001',
        amountXaf: 6400,
        payoutProvider: 'MTN_MOMO',
      }),
    );
  });

  it('persiste l’identifiant prestataire AVANT l’appel réseau', async () => {
    // C'est ce qui rend la reprise sûre : rejouer envoie le MÊME identifiant,
    // et le prestataire répond `DUPLICATE_IGNORED` au lieu de virer deux fois.
    const order: string[] = [];
    const { service, prisma, createPayout } = make(buildRefund());
    prisma.refund.updateMany.mockImplementation(async () => {
      order.push('write');
      return { count: 1 };
    });
    createPayout.mockImplementation(async () => {
      order.push('network');
      return { accepted: true, duplicate: false, raw: {} };
    });

    await service.execute('ref-1', ADMIN);

    expect(order).toEqual(['write', 'network']);
  });

  it('réserve la ligne de façon conditionnelle — deux admins, un seul virement', async () => {
    const { service, prisma } = make(buildRefund());

    await service.execute('ref-1', ADMIN);

    // La réservation porte sur le statut LU : le second appelant affecte
    // 0 ligne et ressort en 409, sans avoir rien envoyé.
    expect(prisma.refund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ref-1', status: 'PENDING' },
      }),
    );
  });

  it('refuse si un autre administrateur a gagné la course', async () => {
    const { service, prisma, createPayout } = make(buildRefund());
    prisma.refund.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.execute('ref-1', ADMIN)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(createPayout).not.toHaveBeenCalled();
  });

  it.each([
    ['déjà clos', { status: 'COMPLETED' }],
    ['virement en cours', { status: 'PROCESSING' }],
    ['montant nul', { amount: 0 }],
    ['aucun encaissement', { payment: null }],
    [
      'encaissement non abouti',
      {
        payment: {
          id: 'p',
          status: 'FAILED',
          phoneNumber: '2420600',
          method: 'MTN_MOMO',
        },
      },
    ],
    [
      'numéro de paiement inconnu',
      {
        payment: {
          id: 'p',
          status: 'SUCCESS',
          phoneNumber: '',
          method: 'MTN_MOMO',
        },
      },
    ],
  ])('refuse : %s', async (_label, over) => {
    const { service, createPayout } = make(buildRefund(over));

    await expect(service.execute('ref-1', ADMIN)).rejects.toBeTruthy();
    expect(createPayout).not.toHaveBeenCalled();
  });

  it('refuse de rembourser si le VENDEUR a déjà été payé', async () => {
    // Sinon la plateforme paie les deux côtés de la même commande. Le vendeur
    // n'est pas reversable tant qu'un remboursement est ouvert
    // (`checkEligibility`) ; la réciproque manquait.
    const { service, createPayout } = make(
      buildRefund({
        order: { id: 'o1', status: 'ANNULER', payout: { status: 'SUCCESS' } },
      }),
    );

    await expect(service.execute('ref-1', ADMIN)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(createPayout).not.toHaveBeenCalled();
  });

  it('laisse la ligne en PROCESSING quand le prestataire est injoignable', async () => {
    // On ne sait pas si la demande est partie : la marquer en échec inviterait
    // un administrateur à réessayer, et le client serait remboursé deux fois.
    const { ProviderUnavailableError } =
      await import('../payments/providers/payment-provider.interface');
    const { service, prisma, createPayout } = make(buildRefund());
    createPayout.mockRejectedValue(
      new ProviderUnavailableError('injoignable', 502),
    );

    const res = await service.execute('ref-1', ADMIN);

    expect(res.status).toBe('PROCESSING');
    // Aucune écriture de statut terminal.
    const statuts = prisma.refund.update.mock.calls.map(
      (c: { 0: { data?: { status?: string } } }) => c[0].data?.status,
    );
    expect(statuts).not.toContain('REJECTED');
    expect(statuts).not.toContain('COMPLETED');
  });

  it('refuse le mode MANUAL plutôt que de faire semblant', async () => {
    const { service } = make(buildRefund());
    (service['registry'] as unknown as { forPayout: () => unknown }).forPayout =
      () => null;

    await expect(service.execute('ref-1', ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe('F-04 — jamais deux sorties d’argent pour une commande', () => {
    it('reversement PENDING lu d’emblée → refusé, aucun virement', async () => {
      const { service, prisma, createPayout } = make(
        buildRefund({
          order: { id: 'o1', status: 'ANNULER', payout: { status: 'PENDING' } },
        }),
      );
      await expect(service.execute('ref-1', ADMIN)).rejects.toThrow(
        /reversement au vendeur est en cours/,
      );
      expect(prisma.refund.updateMany).not.toHaveBeenCalled();
      expect(createPayout).not.toHaveBeenCalled();
    });

    it('reversement apparu entre la lecture et le verrou → refusé sous verrou', async () => {
      const { service, prisma, createPayout } = make(
        buildRefund(),
        {},
        {
          status: 'PENDING',
        },
      );
      await expect(service.execute('ref-1', ADMIN)).rejects.toThrow(
        /reversement au vendeur est en cours/,
      );
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.refund.updateMany).not.toHaveBeenCalled();
      expect(createPayout).not.toHaveBeenCalled();
    });

    it('reversement FAILED : le vendeur n’a rien reçu, on rembourse', async () => {
      const { service, createPayout } = make(
        buildRefund(),
        {},
        {
          status: 'FAILED',
        },
      );
      await service.execute('ref-1', ADMIN);
      expect(createPayout).toHaveBeenCalledTimes(1);
    });
  });

  describe('R-06.5 — F-04 reformulé (F3-06)', () => {
    it('geste de la plateforme sur une commande livrée : le vendeur payé n’y change rien', async () => {
      const { service, prisma, createPayout } = make(
        buildRefund({
          reasonCode: 'GOODWILL',
          bearer: 'PLATFORM',
          order: { id: 'o1', status: 'LIVRER', payout: { status: 'SUCCESS' } },
        }),
        {},
        { status: 'SUCCESS' },
      );
      await service.execute('ref-1', ADMIN);
      expect(createPayout).toHaveBeenCalledTimes(1);
      expect(prisma.restaurantPayout.findUnique).not.toHaveBeenCalled();
    });

    it('échec de livraison dont la plateforme répond : remboursable, vendeur payé', async () => {
      const { service, createPayout } = make(
        buildRefund({
          reasonCode: 'DELIVERY_FAILED',
          bearer: 'PLATFORM',
          order: {
            id: 'o1',
            status: 'ECHEC_LIVRAISON',
            payout: { status: 'SUCCESS' },
          },
        }),
      );
      await service.execute('ref-1', ADMIN);
      expect(createPayout).toHaveBeenCalledTimes(1);
    });

    it('article manquant à la charge du vendeur, vendeur déjà payé : refusé', async () => {
      const { service, createPayout } = make(
        buildRefund({
          reasonCode: 'MISSING_ITEM',
          bearer: 'VENDOR',
          order: { id: 'o1', status: 'LIVRER', payout: { status: 'SUCCESS' } },
        }),
      );
      await expect(service.execute('ref-1', ADMIN)).rejects.toThrow(
        /déjà été reversé/,
      );
      expect(createPayout).not.toHaveBeenCalled();
    });

    it('à la charge du vendeur, reversement apparu sous verrou : refusé', async () => {
      const { service, createPayout } = make(
        buildRefund({ reasonCode: 'DAMAGED', bearer: 'VENDOR' }),
        {},
        { status: 'PENDING' },
      );
      await expect(service.execute('ref-1', ADMIN)).rejects.toThrow(
        /reversement au vendeur est en cours/,
      );
      expect(createPayout).not.toHaveBeenCalled();
    });
  });
});
