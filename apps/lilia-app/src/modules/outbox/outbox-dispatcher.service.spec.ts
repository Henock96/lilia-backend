import { OrderStatus } from '@prisma/client';

import { OutboxDispatcherService } from './outbox-dispatcher.service';

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
  let prisma: { order: { findUnique: jest.Mock } };
  let outbox: {
    claimDue: jest.Mock;
    markSent: jest.Mock;
    markFailed: jest.Mock;
    markEscalated: jest.Mock;
    scheduleRetry: jest.Mock;
  };
  let notifications: { sendPushNotification: jest.Mock };
  let sms: { send: jest.Mock };
  let service: OutboxDispatcherService;

  /** Verrou qui accorde toujours l'exécution. */
  const lock = {
    runExclusively: (_n: string, _t: number, fn: () => unknown) => fn(),
  };

  beforeEach(() => {
    prisma = { order: { findUnique: jest.fn() } };
    outbox = {
      claimDue: jest.fn().mockResolvedValue([]),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      markEscalated: jest.fn().mockResolvedValue(undefined),
      scheduleRetry: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { sendPushNotification: jest.fn().mockResolvedValue(true) };
    sms = { send: jest.fn().mockResolvedValue(true) };

    service = new OutboxDispatcherService(
      prisma as never,
      outbox as never,
      notifications as never,
      sms as never,
      lock as never,
    );
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
});
