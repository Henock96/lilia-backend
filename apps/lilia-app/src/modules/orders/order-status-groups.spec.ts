import { OrderStatus } from '@prisma/client';

import {
  ASSIGNABLE_ORDER_STATUSES,
  IN_FLIGHT_ORDER_STATUSES,
  PAID_ORDER_STATUSES,
  STUCK_ORDER_STATUSES,
} from './order-status-groups';

/**
 * Chaque groupe de statuts métier, tranché **à la main** pour chaque valeur de
 * l'enum.
 *
 * Deux défauts de la même famille motivent ce fichier :
 *  - `EN_ROUTE` absent du chiffre d'affaires : une commande payée en sortait
 *    pendant toute la course (16/09/2026) ;
 *  - `EN_ROUTE` absent du contrôle « premier achat » des codes promo : un
 *    client dont la première commande roulait pouvait réutiliser un code de
 *    bienvenue (constaté le 23/09/2026 en ajoutant `ACCEPTEE`).
 *
 * Les tables ci-dessous doivent couvrir TOUTE valeur d'`OrderStatus` : une
 * valeur ajoutée à l'enum fait échouer ce test tant que quelqu'un n'a pas
 * décidé, groupe par groupe, de quel côté elle tombe.
 */
type Table = Record<OrderStatus, boolean>;

const GROUPS: Array<[string, readonly OrderStatus[], Table]> = [
  [
    'PAID — l’argent a été encaissé et n’a pas été rendu par annulation',
    PAID_ORDER_STATUSES,
    {
      EN_ATTENTE: false,
      PAYER: true,
      ACCEPTEE: true,
      EN_PREPARATION: true,
      PRET: true,
      EN_ROUTE: true,
      LIVRER: true,
      ANNULER: false,
      ECHEC_LIVRAISON: true,
    },
  ],
  [
    'IN_FLIGHT — commande non terminale (bloque la suppression de compte)',
    IN_FLIGHT_ORDER_STATUSES,
    {
      EN_ATTENTE: true,
      PAYER: true,
      ACCEPTEE: true,
      EN_PREPARATION: true,
      PRET: true,
      EN_ROUTE: true,
      LIVRER: false,
      ANNULER: false,
      ECHEC_LIVRAISON: false,
    },
  ],
  [
    'STUCK — payée, pas encore partie : ce qu’un vendeur peut oublier',
    STUCK_ORDER_STATUSES,
    {
      EN_ATTENTE: false,
      PAYER: true,
      ACCEPTEE: true,
      EN_PREPARATION: true,
      PRET: true,
      EN_ROUTE: false,
      LIVRER: false,
      ANNULER: false,
      ECHEC_LIVRAISON: false,
    },
  ],
  [
    'ASSIGNABLE — un livreur peut encore être désigné',
    ASSIGNABLE_ORDER_STATUSES,
    {
      EN_ATTENTE: false,
      PAYER: true,
      ACCEPTEE: true,
      EN_PREPARATION: true,
      PRET: true,
      EN_ROUTE: true,
      LIVRER: false,
      ANNULER: false,
      ECHEC_LIVRAISON: false,
    },
  ],
];

describe('Groupes de statuts de commande — classement exhaustif', () => {
  describe.each(GROUPS)('%s', (_label, group, table) => {
    it('la table tranche chaque valeur de l’enum', () => {
      expect(Object.keys(table).sort()).toEqual(
        Object.values(OrderStatus).sort(),
      );
    });

    it.each(Object.values(OrderStatus))(
      '%s est classé comme la table le dit',
      (status) => {
        expect(group.includes(status)).toBe(table[status]);
      },
    );
  });
});
