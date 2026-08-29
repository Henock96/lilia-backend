import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

import {
  ORDER_TRANSITION_MATRIX,
  OrderActor,
  OrderStateMachine,
} from './order-state.machine';

/**
 * Matrice exhaustive `(depuis, vers, acteur)` — priorité n°3 de l'audit du
 * 28/08/2026 (« zéro test de state machine »).
 *
 * Deux règles y sont vérifiées explicitement parce qu'elles portent de l'argent
 * ou débloquent une commande coincée :
 *  - **H5** : le CLIENT ne peut plus annuler après paiement ;
 *  - **M16** : `EN_PREPARATION`, `PRET` et `EN_ROUTE` ont une sortie vers
 *    `ANNULER` — avant, une commande y restait bloquée à vie, même pour un
 *    ADMIN.
 */
describe('OrderStateMachine — matrice complète', () => {
  const machine = new OrderStateMachine();

  const ALL_STATUSES = Object.values(OrderStatus);
  const ALL_ACTORS: OrderActor[] = [
    'CLIENT',
    'RESTAURATEUR',
    'ADMIN',
    'LIVREUR',
  ];

  describe('exhaustivité : chaque (from, to, acteur) fait ce que la matrice dit', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        for (const actor of ALL_ACTORS) {
          const allowed =
            ORDER_TRANSITION_MATRIX[from]?.[to]?.includes(actor) ?? false;
          const label = `${from} → ${to} par ${actor} : ${allowed ? 'autorisé' : 'refusé'}`;

          it(label, () => {
            if (allowed) {
              expect(() =>
                machine.assertTransition(from, to, actor),
              ).not.toThrow();
            } else {
              expect(() => machine.assertTransition(from, to, actor)).toThrow();
            }
          });
        }
      }
    }
  });

  describe('règles métier explicites', () => {
    it('H5 — le CLIENT ne peut PAS annuler une commande payée', () => {
      expect(() =>
        machine.assertTransition('PAYER', 'ANNULER', 'CLIENT'),
      ).toThrow(ForbiddenException);
    });

    it('H5 — le CLIENT peut toujours annuler avant paiement', () => {
      expect(() =>
        machine.assertTransition('EN_ATTENTE', 'ANNULER', 'CLIENT'),
      ).not.toThrow();
    });

    it("H5 — l'ADMIN, lui, peut annuler après paiement (avec remboursement)", () => {
      expect(() =>
        machine.assertTransition('PAYER', 'ANNULER', 'ADMIN'),
      ).not.toThrow();
    });

    it.each<[OrderStatus]>([['EN_PREPARATION'], ['PRET'], ['EN_ROUTE']])(
      'M16 — %s a une sortie vers ANNULER pour un ADMIN',
      (from) => {
        expect(() =>
          machine.assertTransition(from, 'ANNULER', 'ADMIN'),
        ).not.toThrow();
      },
    );

    it('les états terminaux le restent', () => {
      for (const to of ALL_STATUSES) {
        expect(machine.canTransition('LIVRER', to)).toBe(false);
        expect(machine.canTransition('ANNULER', to)).toBe(false);
      }
    });

    it('une transition inexistante lève 400, un acteur non autorisé lève 403', () => {
      // La distinction compte pour le client mobile : « impossible » et
      // « pas le droit » n'appellent pas le même message.
      expect(() =>
        machine.assertTransition('EN_ATTENTE', 'LIVRER', 'ADMIN'),
      ).toThrow(BadRequestException);

      expect(() =>
        machine.assertTransition('EN_ATTENTE', 'PAYER', 'CLIENT'),
      ).toThrow(ForbiddenException);
    });
  });
});
