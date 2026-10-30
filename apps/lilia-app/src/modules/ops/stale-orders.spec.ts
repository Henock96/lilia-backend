import { OrderStatus } from '@prisma/client';

import {
  ORDER_STALE_RULES,
  SUPERVISED_ORDER_STATUSES,
} from './order-stale-rules';
import { StaleCandidate, evaluateStale } from './stale-orders';

/**
 * Point 6 de l'audit du 28/10/2026 — toute commande non terminale immobile
 * au-delà de son seuil est détectée, quel que soit son état.
 */
const NOW = new Date('2026-10-29T12:00:00Z');
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000);

const candidate = (over: Partial<StaleCandidate>): StaleCandidate => ({
  id: 'o-1',
  status: OrderStatus.EN_PREPARATION,
  isDelivery: true,
  scheduledFor: null,
  paidAt: ago(300),
  updatedAt: ago(300),
  shopName: 'Chez Awa',
  delivererId: null,
  pickedUpAt: null,
  enteredAt: ago(300),
  ...over,
});

describe('Seuils par état — exhaustivité', () => {
  it('chaque statut a un comportement décidé (compilateur + exécution)', () => {
    for (const status of Object.values(OrderStatus)) {
      expect(ORDER_STALE_RULES[status]).toBeDefined();
    }
  });

  it('les états terminaux ne sont jamais signalés', () => {
    for (const status of ['LIVRER', 'ANNULER', 'ECHEC_LIVRAISON'] as const) {
      expect(evaluateStale(candidate({ status }), NOW)).toBeNull();
    }
  });
});

describe('evaluateStale — un cas par état non terminal', () => {
  // [état, contexte, seuil attendu écrit à la main]
  const cases: Array<[OrderStatus, Partial<StaleCandidate>, number]> = [
    ['DEMANDE_ENVOYEE', {}, 3], // lot 3 : avant l'expiration automatique
    ['EN_ATTENTE', {}, 20],
    ['PAYER', {}, 5],
    ['ACCEPTEE', {}, 20],
    ['EN_PREPARATION', {}, 45],
    ['PRET', {}, 15], // livraison, sans livreur
    ['PRET', { delivererId: 'drv-1' }, 15], // livreur assigné qui ne vient pas
    ['PRET', { isDelivery: false }, 60], // retrait non récupéré
    ['EN_ROUTE', { pickedUpAt: null }, 60],
  ];

  it.each(cases)(
    '%s %j : signalé au-delà de %i min, pas avant',
    (status, over, threshold) => {
      const before = candidate({
        status,
        ...over,
        enteredAt: ago(threshold - 1),
      });
      const after = candidate({
        status,
        ...over,
        enteredAt: ago(threshold + 1),
      });
      expect(evaluateStale(before, NOW)).toBeNull();
      expect(evaluateStale(after, NOW)).toMatchObject({
        orderId: 'o-1',
        status,
        thresholdMinutes: threshold,
        sinceSource: 'HISTORY',
      });
    },
  );

  it('tous les états surveillés sont couverts par la table de cas', () => {
    const covered = new Set(cases.map(([s]) => s));
    expect([...SUPERVISED_ORDER_STATUSES].sort()).toEqual([...covered].sort());
  });

  it('un retrait n’a pas de seuil « en route » (l’état n’y a pas de sens)', () => {
    expect(
      evaluateStale(candidate({ status: 'EN_ROUTE', isDelivery: false }), NOW),
    ).toBeNull();
  });
});

describe('evaluateStale — ce qui ne remet pas le compteur à zéro', () => {
  it('une modification sans rapport (updatedAt récent) n’efface pas l’immobilité', () => {
    const c = candidate({
      status: 'EN_PREPARATION',
      enteredAt: ago(60),
      updatedAt: ago(1),
    });
    expect(evaluateStale(c, NOW)?.since).toEqual(ago(60));
  });

  it('sans historique : repli sur updatedAt, et l’item le dit', () => {
    const c = candidate({
      status: 'ACCEPTEE',
      enteredAt: null,
      updatedAt: ago(30),
    });
    expect(evaluateStale(c, NOW)).toMatchObject({ sinceSource: 'UPDATED_AT' });
  });

  it('une précommande n’est pas en retard avant son heure', () => {
    const c = candidate({
      status: 'ACCEPTEE',
      enteredAt: ago(600),
      scheduledFor: new Date(NOW.getTime() + 60 * 60_000),
    });
    expect(evaluateStale(c, NOW)).toBeNull();
  });

  it('une précommande se mesure depuis son heure, pas depuis l’acceptation', () => {
    const c = candidate({
      status: 'ACCEPTEE',
      enteredAt: ago(600),
      scheduledFor: ago(10),
    });
    expect(evaluateStale(c, NOW)).toBeNull(); // 10 min < 20
  });
});
