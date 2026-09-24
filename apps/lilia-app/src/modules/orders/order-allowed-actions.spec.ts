import { OrderStatus } from '@prisma/client';

import {
  ORDER_ACTIONS,
  OrderAction,
  actionTarget,
  orderAllowedActions,
} from './order-allowed-actions';
import { OrderActor, OrderStateMachine } from './order-state.machine';

/**
 * Gestes permis sur une commande, publiés par le serveur (règle R1 du
 * blueprint Phase 3).
 *
 * L'audit du 22/09/2026 a trouvé trois interfaces qui recopiaient la matrice
 * de transitions à la main et proposaient des boutons toujours refusés (400
 * ou 403). Le serveur publie désormais `allowedActions` ; ce test garantit
 * que ce qu'il publie, il l'accepte — sur TOUTES les combinaisons.
 */
describe('orderAllowedActions', () => {
  const machine = new OrderStateMachine();
  const STATUSES = Object.values(OrderStatus);
  const ROLES: OrderActor[] = ['CLIENT', 'RESTAURATEUR', 'ADMIN', 'LIVREUR'];

  /**
   * Ce que les routes acceptent réellement, règles « terrain » comprises
   * (`OrderLifecycleService` : PAYER et ACCEPTEE hors route de statut,
   * EN_ROUTE exige une course, retrait réservé aux commandes à emporter).
   */
  function serverAccepts(
    from: OrderStatus,
    action: OrderAction,
    actor: OrderActor,
    isDelivery: boolean,
    acceptanceRequired: boolean,
  ): boolean {
    const to = actionTarget(action);
    if (!machine.canActorTransition(from, to, actor)) return false;
    if (to === 'PAYER' || to === 'EN_ROUTE') return false;
    if (to === 'LIVRER' && from === 'PRET' && isDelivery) return false;
    if (from === 'PAYER' && to === 'EN_PREPARATION' && acceptanceRequired) {
      return false;
    }
    if (action === 'CANCEL' && actor === 'CLIENT') return from === 'EN_ATTENTE';
    return true;
  }

  describe('tout geste publié est accepté par le serveur', () => {
    for (const status of STATUSES) {
      for (const role of ROLES) {
        for (const isDelivery of [true, false]) {
          for (const acceptanceRequired of [true, false]) {
            const actions = orderAllowedActions({ status, isDelivery }, role, {
              acceptanceRequired,
            });
            for (const action of actions) {
              it(`${status} · ${role} · ${isDelivery ? 'livraison' : 'retrait'} · acceptation ${acceptanceRequired ? 'on' : 'off'} → ${action}`, () => {
                expect(
                  serverAccepts(
                    status,
                    action,
                    role,
                    isDelivery,
                    acceptanceRequired,
                  ),
                ).toBe(true);
              });
            }
          }
        }
      }
    }
  });

  describe('règles écrites à la main (celles qui comptent)', () => {
    const on = { acceptanceRequired: true };
    const off = { acceptanceRequired: false };
    const delivery = (status: OrderStatus) => ({ status, isDelivery: true });

    it('commande payée, acceptation en service : le vendeur voit Accepter et Refuser, pas « préparer »', () => {
      expect(
        orderAllowedActions(delivery('PAYER'), 'RESTAURATEUR', on).sort(),
      ).toEqual(['ACCEPT', 'REJECT']);
    });

    it('acceptation pas encore en service : « préparer » reste proposé (anciens binaires)', () => {
      expect(
        orderAllowedActions(delivery('PAYER'), 'RESTAURATEUR', off),
      ).toEqual(
        expect.arrayContaining(['ACCEPT', 'REJECT', 'START_PREPARATION']),
      );
    });

    it('commande acceptée : préparer ou refuser', () => {
      expect(
        orderAllowedActions(delivery('ACCEPTEE'), 'RESTAURATEUR', on).sort(),
      ).toEqual(['REJECT', 'START_PREPARATION']);
    });

    it('commande prête à livrer : le vendeur ne peut pas la déclarer livrée', () => {
      expect(
        orderAllowedActions(delivery('PRET'), 'RESTAURATEUR', on),
      ).not.toContain('HAND_OVER');
    });

    it('commande prête à emporter : remise au comptoir', () => {
      expect(
        orderAllowedActions(
          { status: 'PRET', isDelivery: false },
          'RESTAURATEUR',
          on,
        ),
      ).toContain('HAND_OVER');
    });

    it('personne ne déclare « en route » ni « payée » depuis une interface', () => {
      for (const status of STATUSES) {
        for (const role of ROLES) {
          const targets = orderAllowedActions(delivery(status), role, on).map(
            actionTarget,
          );
          expect(targets).not.toContain('EN_ROUTE');
          expect(targets).not.toContain('PAYER');
        }
      }
    });

    it('le client ne peut annuler qu’avant paiement', () => {
      expect(orderAllowedActions(delivery('EN_ATTENTE'), 'CLIENT', on)).toEqual(
        ['CANCEL'],
      );
      for (const status of STATUSES.filter((s) => s !== 'EN_ATTENTE')) {
        expect(orderAllowedActions(delivery(status), 'CLIENT', on)).toEqual([]);
      }
    });

    it('le livreur n’agit pas sur la commande (il agit sur la livraison)', () => {
      for (const status of STATUSES) {
        expect(orderAllowedActions(delivery(status), 'LIVREUR', on)).toEqual(
          [],
        );
      }
    });

    it('états terminaux : aucun geste', () => {
      for (const status of ['LIVRER', 'ANNULER', 'ECHEC_LIVRAISON'] as const) {
        for (const role of ROLES) {
          expect(orderAllowedActions(delivery(status), role, on)).toEqual([]);
        }
      }
    });

    it('une course en route ne se conclut pas par le statut de commande, même pour l’ADMIN', () => {
      // La matrice l’autorise, mais la livraison resterait EN_TRANSIT et le
      // livreur ON_DELIVERY : l’arbitrage passe par la livraison (ADMIN_OVERRIDE).
      expect(orderAllowedActions(delivery('EN_ROUTE'), 'ADMIN', on)).toEqual([
        'CANCEL',
      ]);
    });

    it('rôle inconnu : aucun geste plutôt qu’une supposition', () => {
      expect(orderAllowedActions(delivery('PAYER'), 'PIRATE', on)).toEqual([]);
    });

    it('le vocabulaire des gestes est fermé', () => {
      expect([...ORDER_ACTIONS].sort()).toEqual([
        'ACCEPT',
        'CANCEL',
        'HAND_OVER',
        'MARK_READY',
        'REJECT',
        'START_PREPARATION',
      ]);
    });
  });
});
