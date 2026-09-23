import { OrderStatus } from '@prisma/client';

/**
 * Groupes de statuts de commande — **source unique**.
 *
 * Chaque groupe répond à une question métier distincte ; ils se recoupent mais
 * ne se remplacent pas. Ils ne se recopient pas, ils s'importent :
 * `order-status-groups.spec.ts` tranche à la main chaque valeur de l'enum pour
 * chaque groupe, si bien qu'un statut ajouté (`ACCEPTEE`, `ECHEC_LIVRAISON`
 * le 23/09/2026) fait échouer la suite tant que personne n'a décidé de quel
 * côté il tombe.
 */

/**
 * Statuts dans lesquels une commande représente de l'argent réellement encaissé.
 *
 * ⚠️ **Cette liste ne se recopie pas, elle s'importe.** Le total, le total du
 * jour et le graphe hebdomadaire somment tous les trois `Order.total` ; le
 * graphe, lui, n'avait **aucun filtre de statut**. Une même réponse HTTP
 * annonçait donc deux chiffres d'affaires : celui du haut excluait les paniers
 * abandonnés et les annulations, celui du graphe les comptait. Sommer les sept
 * barres ne redonnait pas le total affiché au-dessus.
 *
 * `EN_ATTENTE` n'a jamais donné d'argent — `OrderExpiryService` ferme ces
 * commandes au bout de 45 minutes. `ANNULER` l'a rendu. **Tous les autres
 * statuts de l'enum y sont**, et c'est la règle que
 * `admin-dashboard-revenue-consistency.spec.ts` rend exigible.
 *
 * ⚠️ `EN_ROUTE` manquait — omission, pas décision. La liste énumérait le
 * chemin nominal complet (`PAYER → EN_PREPARATION → PRET → … → LIVRER`) en
 * sautant l'étape du milieu : une commande payée **disparaissait du chiffre
 * d'affaires pendant toute la course**, puis y revenait à la livraison. Aucune
 * lecture métier ne rend l'argent « non encaissé » le temps que le livreur
 * roule. Le défaut est antérieur à la centralisation de cette liste (il vivait
 * dans les deux copies inline) et la production en portait un cas au moment du
 * constat, le 16/09/2026.
 */
export const PAID_ORDER_STATUSES = [
  'PAYER',
  // F3-01 : acceptée = payée. L'oublier referait le défaut d'`EN_ROUTE`.
  'ACCEPTEE',
  'EN_PREPARATION',
  'PRET',
  'EN_ROUTE',
  'LIVRER',
  // F3-05 : l'argent a été encaissé ; un éventuel remboursement est une
  // pièce distincte (`Refund`), comme pour une commande livrée.
  'ECHEC_LIVRAISON',
] as const;

/**
 * Statuts de commande pour lesquels confier une course a un sens.
 *
 * Écrit **une fois** : la liste vivait dans `assignDelivererToOrder`, et
 * `assignDeliverer` (`PATCH /deliveries/:id/assign`) ne la consultait pas du
 * tout. On pouvait donc réassigner une course **déjà livrée** par l'autre
 * porte — ce qui effaçait l'économie du livreur qui l'avait terminée
 * (`CLEARED_DRIVER_ECONOMICS`) et rattachait sa course à quelqu'un d'autre.
 * Le commentaire du schéma affirmait pourtant l'invariant « une fois
 * `Order.status = LIVRER`, toute réassignation est refusée » : il n'était vrai
 * que sur un des deux chemins.
 */
export const ASSIGNABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PAYER,
  // F3-01 : dès l'acceptation, pour que le livreur arrive quand le plat sort.
  OrderStatus.ACCEPTEE,
  OrderStatus.EN_PREPARATION,
  OrderStatus.PRET,
  OrderStatus.EN_ROUTE,
];

/**
 * Commande non terminale : une commande « en vol » interdit, par exemple, la
 * suppression du compte client (`UserDeletionService`).
 */
export const IN_FLIGHT_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.EN_ATTENTE,
  OrderStatus.PAYER,
  OrderStatus.ACCEPTEE,
  OrderStatus.EN_PREPARATION,
  OrderStatus.PRET,
  OrderStatus.EN_ROUTE,
];

/**
 * Argent encaissé et commande pas encore partie : ce qu'un vendeur peut
 * oublier. Définition d'une commande « bloquée » (`countStuckOrders`).
 */
export const STUCK_ORDER_STATUSES = [
  OrderStatus.PAYER,
  OrderStatus.ACCEPTEE,
  OrderStatus.EN_PREPARATION,
  OrderStatus.PRET,
] as const;
