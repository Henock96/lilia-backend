import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentEventSource } from '@prisma/client';

import { PaymentService } from './services/payment.service';
import { PaymentEventService } from './services/payment-event.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Transitions d'encaissement et **concurrence réelle**.
 *
 * Ce fichier se distingue de `payment-collection.spec.ts` sur un point : la base
 * n'y est pas un mock qui rend des compteurs décidés à l'avance, mais une
 * **ligne en mémoire dont l'état évolue**, avec un `updateMany` qui applique
 * réellement sa condition `WHERE status = …`.
 *
 * C'est ce qui permet de tester ce qu'un mock de compteur ne peut pas : faire
 * lire le même état à deux appelants, puis les laisser écrire. Trois sources
 * font avancer un encaissement — le webhook, l'interrogation du client et le
 * cron de réconciliation — et rien n'empêche deux d'entre elles de tomber sur la
 * même transaction à la même seconde. La garantie recherchée n'est pas
 * « ça n'arrive pas », c'est « quand ça arrive, une seule gagne ».
 */
describe('PaymentService — transitions et concurrence', () => {
  let service: PaymentService;

  /** Ligne `payments` en mémoire, mutée par les `updateMany` conditionnels. */
  let paymentRow: Record<string, unknown>;
  /** Ligne `orders` en mémoire. */
  let orderRow: Record<string, unknown>;

  const events = {
    record: jest.fn().mockResolvedValue('evt-1'),
    setOutcome: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  const outbox = { enqueueInTransaction: jest.fn().mockResolvedValue('ob-1') };
  const incidents: unknown[] = [];
  /**
   * Journal `read` / `write` sur la ligne `payments`, dans l'ordre réel
   * d'exécution. Sert à prouver qu'une course a bien eu lieu (cf.
   * `assertReadsRacedBeforeFirstWrite`).
   */
  let callLog: ('read' | 'write')[] = [];

  /**
   * Rendez-vous sur la lecture, pour fabriquer une course déterministe.
   *
   * Un simple `await` ne suffit pas : le premier appelant reprend la main par
   * la file des micro-tâches et atteint son écriture avant que le second n'ait
   * seulement lu. Le test passerait alors — mais en séquence, sans jamais
   * exercer la situation qu'il prétend couvrir.
   *
   * Ici, chaque lecteur se bloque jusqu'à ce que le nombre attendu soit
   * arrivé ; **tous** lisent donc le même `PENDING` avant que quiconque
   * n'écrive. C'est précisément ce qu'un `if (status === 'PENDING')` suivi d'un
   * `update` ne survit pas, et ce que l'`updateMany` conditionnel doit encaisser.
   */
  let rendezvous: {
    expected: number;
    arrived: number;
    open?: () => void;
    gate?: Promise<void>;
  } | null = null;

  const raceOn = (expected: number) => {
    const r: typeof rendezvous = { expected, arrived: 0 };
    r!.gate = new Promise<void>((resolve) => {
      r!.open = resolve;
    });
    rendezvous = r;
  };

  const arriveAtRendezvous = async () => {
    if (!rendezvous) return;
    const r = rendezvous;
    r.arrived += 1;
    if (r.arrived >= r.expected) {
      r.open!();
      return;
    }
    await r.gate;
  };

  const prisma = {
    payment: {
      findUnique: jest.fn(async () => {
        await arriveAtRendezvous();
        callLog.push('read');
        return { ...paymentRow, order: { ...orderRow } };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ ...paymentRow })),
      findFirst: jest.fn(async () => ({ ...paymentRow })),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          callLog.push('write');
          // La condition de la base, appliquée pour de vrai.
          if (where.status && paymentRow.status !== where.status) {
            return { count: 0 };
          }
          Object.assign(paymentRow, data);
          return { count: 1 };
        },
      ),
      create: jest.fn(),
      count: jest.fn(async () => 0),
    },
    order: {
      findUnique: jest.fn(async () => ({ ...orderRow })),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (where.status && orderRow.status !== where.status) {
            return { count: 0 };
          }
          Object.assign(orderRow, data);
          return { count: 1 };
        },
      ),
    },
    user: { findUnique: jest.fn() },
    paymentEvent: { findFirst: jest.fn(async () => null) },
    incident: {
      create: jest.fn(async (args: unknown) => {
        incidents.push(args);
        return { id: 'inc-1' };
      }),
    },
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
  const registry = {
    currentMode: 'PAWAPAY',
    forNewTransaction: () => provider,
    forStoredProvider: () => provider,
    forPayout: () => provider,
  };

  /** Statut terminal annoncé par le prestataire. */
  const providerSays = (
    state: 'SUCCESS' | 'FAILED' | 'PENDING',
    overrides: Record<string, unknown> = {},
  ) => ({
    state,
    rawStatus: state === 'SUCCESS' ? 'COMPLETED' : state,
    amountXaf: 6400,
    currency: 'XAF',
    raw: {},
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    incidents.length = 0;
    callLog = [];
    rendezvous = null;

    paymentRow = {
      id: 'pay-1',
      orderId: 'o1',
      amount: 6400,
      currency: 'XAF',
      method: 'MTN_MOMO',
      provider: 'PAWAPAY',
      providerTransactionId: 'uuid-1',
      status: 'PENDING',
      failureCode: null,
      failureMessage: null,
      completedAt: null,
      createdAt: new Date('2026-08-31T10:00:00Z'),
    };
    orderRow = {
      id: 'o1',
      userId: 'u1',
      restaurantId: 'r1',
      status: 'EN_ATTENTE',
    };

    prisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as unknown[]),
    );
    events.record.mockResolvedValue('evt-1');
    outbox.enqueueInTransaction.mockResolvedValue('ob-1');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: PaymentEventService, useValue: events },
        { provide: PaymentProviderRegistry, useValue: registry },
        { provide: OutboxService, useValue: outbox },
        {
          provide: ConfigService,
          useValue: { get: (_k: string, d?: unknown) => d },
        },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  const apply = (
    state: 'SUCCESS' | 'FAILED' | 'PENDING',
    source: PaymentEventSource = PaymentEventSource.WEBHOOK,
    overrides: Record<string, unknown> = {},
  ) =>
    service.applyCollectionProviderStatus({
      paymentId: 'pay-1',
      status: providerSays(state, overrides) as never,
      source,
    });

  // ══════════════════════════════════════════════════════════════════════════
  /**
   * La matrice **réellement** appliquée par le code, écrite à la main.
   *
   * Elle n'est dérivée d'aucune constante du code de production : une spec qui
   * relit la table qu'elle prétend vérifier ne vérifie que sa propre lecture.
   */
  describe('matrice de transitions', () => {
    it('PENDING → SUCCESS : appliqué, commande PAYER', async () => {
      await expect(apply('SUCCESS')).resolves.toBe('APPLIED');
      expect(paymentRow.status).toBe('SUCCESS');
      expect(orderRow.status).toBe('PAYER');
    });

    it('PENDING → FAILED : appliqué, commande INCHANGÉE et toujours payable', async () => {
      await expect(apply('FAILED')).resolves.toBe('APPLIED');
      expect(paymentRow.status).toBe('FAILED');
      // L'invariant qui rend la reprise possible.
      expect(orderRow.status).toBe('EN_ATTENTE');
    });

    it('PENDING → PENDING : ignoré, rien n’est écrit', async () => {
      await expect(apply('PENDING')).resolves.toBe('IGNORED');
      expect(paymentRow.status).toBe('PENDING');
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['SUCCESS', 'FAILED'],
      ['SUCCESS', 'SUCCESS'],
      ['FAILED', 'SUCCESS'],
      ['FAILED', 'FAILED'],
      ['CANCELLED', 'SUCCESS'],
      ['CANCELLED', 'FAILED'],
    ] as const)(
      'un encaissement %s ne devient pas %s : DUPLICATE, aucune écriture',
      async (from, to) => {
        paymentRow.status = from;
        // Une commande déjà annulée par l'administrateur, cas le plus dangereux.
        orderRow.status = from === 'SUCCESS' ? 'PAYER' : 'EN_ATTENTE';

        await expect(apply(to)).resolves.toBe('DUPLICATE');

        expect(paymentRow.status).toBe(from);
        expect(orderRow.status).toBe(
          from === 'SUCCESS' ? 'PAYER' : 'EN_ATTENTE',
        );
        expect(outbox.enqueueInTransaction).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      },
    );

    it('devise incohérente → MISMATCH, incident, aucune transition', async () => {
      await expect(
        apply('SUCCESS', PaymentEventSource.WEBHOOK, { currency: 'USD' }),
      ).resolves.toBe('MISMATCH');

      expect(paymentRow.status).toBe('PENDING');
      expect(orderRow.status).toBe('EN_ATTENTE');
      expect(incidents).toHaveLength(1);
    });

    it('paiement inconnu → IGNORED, sans lever', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null as never);
      await expect(apply('SUCCESS')).resolves.toBe('IGNORED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  /**
   * Trois sources concurrentes, une seule vérité.
   *
   * Chaque test fait **lire le même `PENDING`** aux deux appelants avant que
   * l'un d'eux n'écrive — c'est exactement la situation qu'un `if (status ===
   * 'PENDING')` suivi d'un `update` ne survit pas.
   */
  describe('concurrence', () => {
    /**
     * Garde-fou du garde-fou.
     *
     * Sans cette vérification, un test de « concurrence » peut passer pour la
     * mauvaise raison : si le premier appel s'exécutait entièrement avant que le
     * second ne démarre, le second lirait `SUCCESS` et renverrait `DUPLICATE`
     * sans qu'aucune course n'ait eu lieu. On exige donc explicitement que les
     * **deux lectures précèdent la première écriture** — la situation qu'un
     * `if (status === 'PENDING')` suivi d'un `update` ne survit pas.
     */
    const assertReadsRacedBeforeFirstWrite = () => {
      const firstWrite = callLog.indexOf('write');
      const reads = callLog.filter((c) => c === 'read').length;
      expect(firstWrite).toBeGreaterThan(0);
      expect(
        callLog.slice(0, firstWrite).filter((c) => c === 'read').length,
      ).toBeGreaterThanOrEqual(2);
      expect(reads).toBeGreaterThanOrEqual(2);
    };

    it('webhook + interrogation client simultanés → une seule confirmation', async () => {
      raceOn(2);
      const outcomes = await Promise.all([
        apply('SUCCESS', PaymentEventSource.WEBHOOK),
        apply('SUCCESS', PaymentEventSource.CLIENT_POLL),
      ]);

      assertReadsRacedBeforeFirstWrite();

      expect(outcomes.sort()).toEqual(['APPLIED', 'DUPLICATE']);
      expect(paymentRow.status).toBe('SUCCESS');
      expect(orderRow.status).toBe('PAYER');

      // Le vendeur n'est prévenu qu'une fois, et la commande n'est
      // « confirmée » qu'une fois.
      expect(outbox.enqueueInTransaction).toHaveBeenCalledTimes(1);
      expect(
        eventEmitter.emit.mock.calls.filter(
          ([name]) => name === 'order.payment.confirmed',
        ),
      ).toHaveLength(1);
    });

    it('webhook + cron de réconciliation simultanés → une seule confirmation', async () => {
      raceOn(2);
      const outcomes = await Promise.all([
        apply('SUCCESS', PaymentEventSource.WEBHOOK),
        apply('SUCCESS', PaymentEventSource.RECONCILIATION),
      ]);

      assertReadsRacedBeforeFirstWrite();
      expect(outcomes.sort()).toEqual(['APPLIED', 'DUPLICATE']);
      expect(outbox.enqueueInTransaction).toHaveBeenCalledTimes(1);
    });

    it('trois sources en même temps → une seule gagne', async () => {
      raceOn(3);
      const outcomes = await Promise.all([
        apply('SUCCESS', PaymentEventSource.WEBHOOK),
        apply('SUCCESS', PaymentEventSource.CLIENT_POLL),
        apply('SUCCESS', PaymentEventSource.RECONCILIATION),
      ]);

      assertReadsRacedBeforeFirstWrite();
      expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(2);
      expect(outbox.enqueueInTransaction).toHaveBeenCalledTimes(1);
    });

    it('SUCCESS et FAILED concurrents : le premier écrit gagne, l’autre ne défait rien', async () => {
      raceOn(2);
      const outcomes = await Promise.all([
        apply('SUCCESS', PaymentEventSource.WEBHOOK),
        apply('FAILED', PaymentEventSource.RECONCILIATION),
      ]);

      assertReadsRacedBeforeFirstWrite();
      expect(outcomes.sort()).toEqual(['APPLIED', 'DUPLICATE']);
      // Quel que soit l'ordre d'ordonnancement, l'état final est cohérent :
      // jamais un paiement SUCCESS sur une commande restée EN_ATTENTE, jamais
      // un paiement FAILED sur une commande passée PAYER.
      if (paymentRow.status === 'SUCCESS') {
        expect(orderRow.status).toBe('PAYER');
      } else {
        expect(paymentRow.status).toBe('FAILED');
        expect(orderRow.status).toBe('EN_ATTENTE');
      }
    });

    it('deux confirmations sur une commande déjà expirée → orphelin signalé une seule fois', async () => {
      // La commande a été annulée par le cron d'expiration pendant que le
      // client payait : l'argent existe, la commande non.
      orderRow.status = 'ANNULER';

      raceOn(2);
      const outcomes = await Promise.all([
        apply('SUCCESS', PaymentEventSource.WEBHOOK),
        apply('SUCCESS', PaymentEventSource.CLIENT_POLL),
      ]);

      assertReadsRacedBeforeFirstWrite();
      expect(outcomes.sort()).toEqual(['APPLIED', 'DUPLICATE']);
      expect(paymentRow.status).toBe('SUCCESS');
      // AUCUNE transition forcée : on ne ressuscite pas une commande annulée.
      expect(orderRow.status).toBe('ANNULER');
      expect(
        eventEmitter.emit.mock.calls.filter(
          ([name]) => name === 'payment.orphaned',
        ),
      ).toHaveLength(1);
      // Et surtout : le vendeur n'est PAS prévenu d'une commande à préparer.
      expect(outbox.enqueueInTransaction).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  /**
   * L'interrogation du client ne décide de rien — elle relaie ce que dit le
   * prestataire. Un navigateur qui cesse d'interroger ne change aucun statut.
   */
  describe('interrogation client', () => {
    it('un statut terminal est lu en base, sans appeler le prestataire', async () => {
      paymentRow.status = 'SUCCESS';
      prisma.payment.findUnique.mockResolvedValueOnce({
        ...paymentRow,
        order: { userId: 'u1', status: 'PAYER' },
      } as never);

      const res = await service.checkPaymentStatus('pay-1');

      expect(res.status).toBe('SUCCESS');
      expect(provider.getCollectionStatus).not.toHaveBeenCalled();
    });

    it('une interrogation qui échoue rend le dernier état connu, sans rien casser', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce({
        ...paymentRow,
        order: { userId: 'u1', status: 'EN_ATTENTE' },
      } as never);
      provider.getCollectionStatus.mockRejectedValueOnce(
        new Error('réseau indisponible'),
      );

      const res = await service.checkPaymentStatus('pay-1');

      expect(res.status).toBe('PENDING');
      expect(paymentRow.status).toBe('PENDING');
    });
  });
});
