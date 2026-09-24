import { OrderStatus } from '@prisma/client';

import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { OrderOutboxEffectsService } from './order-outbox-effects.service';

/**
 * Reprise des notifications vendeur en souffrance (fix H7).
 *
 * L'outbox existe parce que le push FCM est *best-effort* : un téléphone
 * éteint, une coupure réseau, un token périmé, et le vendeur ne sait jamais
 * qu'une commande payée l'attend. Le client, lui, a débité son MoMo.
 *
 * Ce dispatcher est donc le dernier filet. Deux comportements font toute sa
 * valeur, et c'est ce que ces tests figent :
 *
 *  - **il n'acquitte que sur preuve de prise en charge** — pas sur l'envoi
 *    réussi d'un push, qui ne prouve rien ;
 *  - **il escalade en SMS** au bout de 10 minutes, seul canal qui atteint un
 *    vendeur dont l'application est fermée.
 *
 * Le module était livré sans aucun test (audit post-correction).
 */
describe('OutboxDispatcherService', () => {
  let prisma: {
    order: { findUnique: jest.Mock };
    restaurant: { findUnique: jest.Mock };
    platformSettings: { findUnique: jest.Mock };
  };
  let outbox: {
    claimDue: jest.Mock;
    markSent: jest.Mock;
    markFailed: jest.Mock;
    markEscalated: jest.Mock;
    scheduleRetry: jest.Mock;
  };
  let notifications: { sendPushNotification: jest.Mock };
  let sms: { send: jest.Mock };
  let invitations: { sendForVendor: jest.Mock };
  let loyalty: { awardForDeliveredOrder: jest.Mock };
  let referral: { rewardForDeliveredOrder: jest.Mock };
  let refunds: { openForCancelledOrder: jest.Mock };
  let service: OutboxDispatcherService;

  /** Verrou qui accorde toujours l'exécution. */
  const lock = {
    runExclusively: (_n: string, _t: number, fn: () => unknown) => fn(),
  };

  beforeEach(() => {
    prisma = {
      order: { findUnique: jest.fn() },
      restaurant: { findUnique: jest.fn() },
      platformSettings: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ vendorAcceptanceReminderLeadMinutes: 3 }),
      },
    };
    outbox = {
      claimDue: jest.fn().mockResolvedValue([]),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      markEscalated: jest.fn().mockResolvedValue(undefined),
      scheduleRetry: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { sendPushNotification: jest.fn().mockResolvedValue(true) };
    // Le double rend ce que rend le vrai service : une issue, pas un booléen.
    sms = { send: jest.fn().mockResolvedValue('SENT') };
    invitations = {
      sendForVendor: jest
        .fn()
        .mockResolvedValue({ emailSent: true, smsSent: true, detail: 'ok' }),
    };

    loyalty = {
      awardForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
    };
    referral = {
      rewardForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
    };
    refunds = { openForCancelledOrder: jest.fn().mockResolvedValue(null) };

    service = new OutboxDispatcherService(
      prisma as never,
      outbox as never,
      notifications as never,
      sms as never,
      lock as never,
      invitations as never,
    );
    // Les effets de commande (lot 4) s'inscrivent auprès du dispatcher, comme
    // au démarrage réel de l'application.
    new OrderOutboxEffectsService(
      prisma as never,
      outbox as never,
      service,
      notifications as never,
      loyalty as never,
      referral as never,
      refunds as never,
      { execute: jest.fn() } as never, // RefundExecutionService (F3-01)
    ).onModuleInit();
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  const event = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'evt-1',
    type: 'order.created',
    aggregateId: 'o-1',
    attempts: 0,
    escalatedAt: null,
    ...over,
  });

  const order = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'o-1',
    status: OrderStatus.PAYER,
    total: 6400,
    createdAt: new Date(),
    restaurant: {
      nom: 'Chez Awa',
      ownerId: 'owner-1',
      owner: { phone: '060000000' },
    },
    ...over,
  });

  describe('acquittement', () => {
    it('acquitte dès que le vendeur a ouvert la commande', async () => {
      // `EN_PREPARATION` prouve que le signal a atteint sa cible — peu importe
      // par quelle voie. C'est la seule preuve acceptable.
      outbox.claimDue.mockResolvedValue([event()]);
      prisma.order.findUnique.mockResolvedValue(
        order({ status: OrderStatus.EN_PREPARATION }),
      );

      await service.dispatchPending();

      expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });

    it("n'acquitte PAS après un push réussi sur une commande non ouverte", async () => {
      // Le point central de l'outbox : un push « envoyé » ne prouve pas qu'il
      // a été reçu. Acquitter ici ferait retomber le système dans le
      // best-effort qu'il est censé corriger.
      outbox.claimDue.mockResolvedValue([event()]);
      prisma.order.findUnique.mockResolvedValue(order());

      await service.dispatchPending();

      expect(notifications.sendPushNotification).toHaveBeenCalled();
      expect(outbox.markSent).not.toHaveBeenCalled();
      expect(outbox.scheduleRetry).toHaveBeenCalled();
    });

    it('abandonne une commande introuvable plutôt que de la rejouer sans fin', async () => {
      outbox.claimDue.mockResolvedValue([event()]);
      prisma.order.findUnique.mockResolvedValue(null);

      await service.dispatchPending();

      expect(outbox.markFailed).toHaveBeenCalledWith(
        'evt-1',
        'Commande introuvable',
      );
    });

    it('abandonne un type d’événement qu’il ne sait pas traiter', async () => {
      outbox.claimDue.mockResolvedValue([event({ type: 'type.inconnu' })]);

      await service.dispatchPending();

      expect(outbox.markFailed).toHaveBeenCalledWith(
        'evt-1',
        expect.stringContaining('non géré'),
      );
    });
  });

  describe('escalade SMS', () => {
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

    it('envoie un SMS après 10 minutes sans prise en charge', async () => {
      // Le SMS est le seul canal qui atteint un vendeur dont l'application est
      // fermée — le cas exact où le push a déjà échoué.
      outbox.claimDue.mockResolvedValue([event()]);
      prisma.order.findUnique.mockResolvedValue(
        order({ createdAt: minutesAgo(12) }),
      );

      await service.dispatchPending();

      expect(sms.send).toHaveBeenCalledWith(
        '060000000',
        expect.stringContaining('attend depuis'),
      );
      expect(outbox.markEscalated).toHaveBeenCalledWith('evt-1');
    });

    it("n'escalade pas une commande encore récente", async () => {
      outbox.claimDue.mockResolvedValue([event()]);
      prisma.order.findUnique.mockResolvedValue(
        order({ createdAt: minutesAgo(3) }),
      );

      await service.dispatchPending();

      expect(sms.send).not.toHaveBeenCalled();
    });

    it("n'envoie qu'un seul SMS, même si la commande reste ouverte", async () => {
      // Sans cette garde, un vendeur en congé recevrait un SMS toutes les
      // 30 secondes — facturé, et vite ignoré.
      outbox.claimDue.mockResolvedValue([
        event({ escalatedAt: minutesAgo(5) }),
      ]);
      prisma.order.findUnique.mockResolvedValue(
        order({ createdAt: minutesAgo(30) }),
      );

      await service.dispatchPending();

      expect(sms.send).not.toHaveBeenCalled();
      // Le rappel push, lui, continue : l'obligation demeure.
      expect(outbox.scheduleRetry).toHaveBeenCalled();
    });

    it("n'acquitte PAS l'escalade quand le SMS a été refusé", async () => {
      // Le cœur du défaut : `markEscalated` était appelé sans lire le retour de
      // `send()`. Un SMS refusé par l'opérateur — ou un compte d'essai qui ne
      // livre qu'aux numéros vérifiés — marquait donc le dernier filet comme
      // consommé, et il n'était jamais rejoué.
      outbox.claimDue.mockResolvedValue([event()]);
      prisma.order.findUnique.mockResolvedValue(
        order({ createdAt: minutesAgo(20) }),
      );
      sms.send.mockResolvedValue('FAILED');

      await service.dispatchPending();

      expect(sms.send).toHaveBeenCalled();
      expect(outbox.markEscalated).not.toHaveBeenCalled();
      // L'obligation demeure : le backoff rejouera, borné par MAX_ATTEMPTS.
      expect(outbox.scheduleRetry).toHaveBeenCalled();
    });

    it("n'acquitte PAS l'escalade quand le SMS n'est pas configuré", async () => {
      outbox.claimDue.mockResolvedValue([event()]);
      prisma.order.findUnique.mockResolvedValue(
        order({ createdAt: minutesAgo(20) }),
      );
      sms.send.mockResolvedValue('SKIPPED');

      await service.dispatchPending();

      expect(outbox.markEscalated).not.toHaveBeenCalled();
    });

    it("n'acquitte PAS l'escalade d'une commande PAYÉE quand le SMS échoue", async () => {
      // Même garantie sur `order.paid`, qui est le chemin réel depuis pawaPay :
      // c'est celui où le client a déjà payé.
      outbox.claimDue.mockResolvedValue([event({ type: 'order.paid' })]);
      prisma.order.findUnique.mockResolvedValue(
        order({ paidAt: minutesAgo(20), createdAt: minutesAgo(40) }),
      );
      sms.send.mockResolvedValue('FAILED');

      await service.dispatchPending();

      expect(sms.send).toHaveBeenCalled();
      expect(outbox.markEscalated).not.toHaveBeenCalled();
    });

    it('acquitte une escalade réellement partie sur une commande payée', async () => {
      outbox.claimDue.mockResolvedValue([event({ type: 'order.paid' })]);
      prisma.order.findUnique.mockResolvedValue(
        order({ paidAt: minutesAgo(20), createdAt: minutesAgo(40) }),
      );
      sms.send.mockResolvedValue('SENT');

      await service.dispatchPending();

      expect(outbox.markEscalated).toHaveBeenCalledWith('evt-1');
    });

    it('continue sans SMS si le vendeur n’a pas de téléphone', async () => {
      // Une escalade impossible ne doit pas faire échouer le dispatch : le
      // push reste programmé.
      outbox.claimDue.mockResolvedValue([event()]);
      prisma.order.findUnique.mockResolvedValue(
        order({
          createdAt: minutesAgo(20),
          restaurant: {
            nom: 'Chez Awa',
            ownerId: 'owner-1',
            owner: { phone: null },
          },
        }),
      );

      await service.dispatchPending();

      expect(sms.send).not.toHaveBeenCalled();
      expect(outbox.scheduleRetry).toHaveBeenCalled();
    });
  });

  describe('rappel avant l’échéance d’acceptation (F3-01)', () => {
    // Le SMS « 10 min » n'était évalué qu'aux relances, dont le délai double
    // (0,5 → 1,5 → 3,5 → 7,5 → 15,5 min) : il partait vers 15 min. Avec une
    // annulation à 8 min (D1), le vendeur n'aurait jamais été prévenu.
    const inMinutes = (n: number) => new Date(Date.now() + n * 60_000);
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

    it('envoie le SMS à échéance − 3 min, bien avant les 10 minutes historiques', async () => {
      outbox.claimDue.mockResolvedValue([
        event({ type: 'order.paid', attempts: 3 }),
      ]);
      prisma.order.findUnique.mockResolvedValue(
        order({ paidAt: minutesAgo(6), acceptDeadlineAt: inMinutes(2) }),
      );

      await service.dispatchPending();

      expect(sms.send).toHaveBeenCalledTimes(1);
      expect(outbox.markEscalated).toHaveBeenCalledWith('evt-1');
    });

    it('trop tôt : pas de SMS, mais la relance suivante est calée sur l’instant du rappel', async () => {
      const deadline = inMinutes(7);
      outbox.claimDue.mockResolvedValue([
        event({ type: 'order.paid', attempts: 4 }),
      ]);
      prisma.order.findUnique.mockResolvedValue(
        order({ paidAt: minutesAgo(1), acceptDeadlineAt: deadline }),
      );

      await service.dispatchPending();

      expect(sms.send).not.toHaveBeenCalled();
      const [, , , notAfter] = outbox.scheduleRetry.mock.calls[0];
      expect(notAfter).toEqual(new Date(deadline.getTime() - 3 * 60_000));
    });

    it('sans échéance (acceptation non mise en service) : la règle des 10 minutes est inchangée', async () => {
      outbox.claimDue.mockResolvedValue([event({ type: 'order.paid' })]);
      prisma.order.findUnique.mockResolvedValue(
        order({ paidAt: minutesAgo(6), acceptDeadlineAt: null }),
      );

      await service.dispatchPending();

      expect(sms.send).not.toHaveBeenCalled();
    });
  });

  describe('résistance aux pannes', () => {
    it('replanifie un événement dont le traitement a échoué', async () => {
      outbox.claimDue.mockResolvedValue([event({ attempts: 2 })]);
      prisma.order.findUnique.mockRejectedValue(new Error('base injoignable'));

      await service.dispatchPending();

      expect(outbox.scheduleRetry).toHaveBeenCalledWith(
        'evt-1',
        2,
        'base injoignable',
      );
      expect(outbox.markFailed).not.toHaveBeenCalled();
    });

    it('abandonne au bout de 8 tentatives', async () => {
      // Sans plafond, un événement empoisonné occuperait le lot toutes les
      // 30 secondes indéfiniment, retardant les notifications légitimes.
      outbox.claimDue.mockResolvedValue([event({ attempts: 7 })]);
      prisma.order.findUnique.mockRejectedValue(new Error('erreur définitive'));

      await service.dispatchPending();

      expect(outbox.markFailed).toHaveBeenCalledWith(
        'evt-1',
        'erreur définitive',
      );
    });

    it("l'échec d'un événement n'empêche pas les suivants d'être traités", async () => {
      // Une commande cassée ne doit pas bloquer la file : c'est tout l'intérêt
      // de traiter par lots.
      outbox.claimDue.mockResolvedValue([
        event({ id: 'evt-cassé' }),
        event({ id: 'evt-sain', aggregateId: 'o-2' }),
      ]);
      prisma.order.findUnique
        .mockRejectedValueOnce(new Error('panne'))
        .mockResolvedValue(order({ status: OrderStatus.EN_PREPARATION }));

      await service.dispatchPending();

      expect(outbox.markSent).toHaveBeenCalledWith('evt-sain');
    });
  });

  // ═══ Lot 4 — obligations durables ═══════════════════════════════════════
  describe('obligations durables (lot 4)', () => {
    const run = async (type: string, payload: unknown = {}) => {
      outbox.claimDue.mockResolvedValue([
        event({ type, aggregateId: 'o-1', payload }),
      ]);
      await service.dispatchPending();
    };

    it('commande livrée : fidélité ET parrainage, puis acquittement', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'o-1',
        userId: 'c-1',
        status: 'LIVRER',
      });
      await run('order.delivered');
      expect(loyalty.awardForDeliveredOrder).toHaveBeenCalledWith('c-1', 'o-1');
      expect(referral.rewardForDeliveredOrder).toHaveBeenCalledWith(
        'c-1',
        'o-1',
      );
      expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
    });

    it('commande NON livrée : aucune récompense, obligation close en échec', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'o-1',
        userId: 'c-1',
        status: 'EN_ROUTE',
      });
      await run('order.delivered');
      expect(loyalty.awardForDeliveredOrder).not.toHaveBeenCalled();
      expect(referral.rewardForDeliveredOrder).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalled();
    });

    it('échec de la fidélité : l’obligation reste ouverte (rejouée plus tard)', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'o-1',
        userId: 'c-1',
        status: 'LIVRER',
      });
      loyalty.awardForDeliveredOrder.mockRejectedValue(new Error('DB down'));
      await run('order.delivered');
      expect(outbox.markSent).not.toHaveBeenCalled();
      expect(outbox.scheduleRetry).toHaveBeenCalled();
    });

    it('remboursement dû : ouvert avec le motif et l’auteur de l’annulation', async () => {
      prisma.order.findUnique.mockResolvedValue({ status: 'ANNULER' });
      await run('order.refund_due', {
        reason: 'Annulation par restaurateur',
        requestedBy: 'u-v',
      });
      expect(refunds.openForCancelledOrder).toHaveBeenCalledWith({
        orderId: 'o-1',
        reason: 'Annulation par restaurateur',
        requestedBy: 'u-v',
        reasonCode: 'ORDER_CANCELLED',
      });
      expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
    });

    it('remboursement dû sur une commande non annulée : rien n’est ouvert', async () => {
      prisma.order.findUnique.mockResolvedValue({ status: 'LIVRER' });
      await run('order.refund_due');
      expect(refunds.openForCancelledOrder).not.toHaveBeenCalled();
    });

    it('commande expirée : le client est prévenu (le worker n’a aucun listener)', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'o-1',
        userId: 'c-1',
        status: 'ANNULER',
      });
      await run('order.expired');
      expect(notifications.sendPushNotification).toHaveBeenCalledWith(
        'c-1',
        expect.stringContaining('expirée'),
        expect.any(String),
        expect.objectContaining({ orderId: 'o-1' }),
      );
      expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
    });
  });
});

describe('OutboxDispatcherService.registerHandler', () => {
  it('refuse une double inscription pour le même type (collision silencieuse sinon)', () => {
    const d = new OutboxDispatcherService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    d.registerHandler('x', async () => undefined);
    expect(() => d.registerHandler('x', async () => undefined)).toThrow(
      /déjà inscrit/,
    );
  });
});
