# Machine à états des commandes — référence

Source de vérité : `apps/lilia-app/src/modules/orders/order-state.machine.ts`
(`ORDER_TRANSITION_MATRIX`), appliquée par `OrderTransitionService` —
**seul point d'écriture de `Order.status`**, en compare-and-swap
(`updateMany WHERE status = from`) avec sa ligne `OrderHistory` dans la même
transaction. Mise à jour : Phase 2 du Master Audit v1 (23/09/2026).

## Matrice

| De | Vers | Acteur | Route / déclencheur | Conditions supplémentaires | Effets (même transaction) | Effets après commit | Argent |
|---|---|---|---|---|---|---|---|
| ∅ | EN_ATTENTE | CLIENT | `POST /orders/checkout` | panier verrouillé et inchangé (F-11), vendeur publié et ouvert, stock, menus valides (F-02) | stock (menu = q unités, F-01), points, usage promo, panier vidé | `order.created` | aucun |
| EN_ATTENTE | PAYER | SYSTEM | webhook / réconciliation / `POST /payments/:id/confirm` (MANUAL) | `Payment` PENDING → SUCCESS (CAS) | outbox `order.paid` | notifications | encaissé |
| EN_ATTENTE | PAYER | ADMIN via `PATCH /orders/:id/status` | — | **refusé (400)** depuis F-07 | — | — | — |
| EN_ATTENTE | ANNULER | CLIENT | `PATCH /orders/:id/cancel` | — | stock, points, promo restitués | `order.cancelled` | aucun |
| EN_ATTENTE | ANNULER | SYSTEM | cron d'expiration (worker) | délai dépassé, aucun SUCCESS | restitutions + `Payment` PENDING → CANCELLED + outbox `order.expired` | — | aucun |
| EN_ATTENTE | ANNULER | RESTAURATEUR, ADMIN | `PATCH /orders/:id/status` | — | restitutions + outbox `order.refund_due` | remboursement (si encaissé) | aucun |
| PAYER | EN_PREPARATION | RESTAURATEUR, ADMIN | `PATCH /orders/:id/status` | propriétaire du vendeur | — | notifications ; ADMIN → audit `ORDER_STATUS_FORCED` | — |
| PAYER / EN_PREPARATION / PRET | ANNULER | RESTAURATEUR | `PATCH /orders/:id/status` | **aucun reversement PENDING/SUCCESS** (F-04, 409 sinon) | restitutions + outbox `order.refund_due` | remboursement ouvert | remboursement dû |
| PAYER / EN_PREPARATION / PRET / EN_ROUTE | ANNULER | ADMIN | `PATCH /orders/:id/status` | — (arbitrage) | idem + audit | remboursement ouvert ; **exécution bloquée si reversement PENDING/SUCCESS** | remboursement dû |
| EN_PREPARATION | PRET | RESTAURATEUR, ADMIN | `PATCH /orders/:id/status` | — | — | livreur prévenu | **reversement vendeur possible** (décision métier : « le vendeur a fait son travail ») |
| PRET | EN_ROUTE | LIVREUR | `PATCH /deliveries/:id/pickup` | titulaire de la course, commande encore PRET | livraison EN_TRANSIT, **code de remise tiré** (F-06) | client prévenu | — |
| PRET | LIVRER | RESTAURATEUR, ADMIN | `PATCH /orders/:id/status` | **retrait au comptoir uniquement** (`isDelivery = false`) | outbox `order.delivered` | fidélité, parrainage | — |
| EN_ROUTE | LIVRER | LIVREUR | `PATCH /deliveries/:id/status { LIVRER, handoverCode }` | titulaire (CAS), code de remise valide (ou transition non exigée) | livraison LIVRER + `handoverMethod`, livreur AVAILABLE, outbox `order.delivered` | fidélité, parrainage | — |
| EN_ROUTE | LIVRER | ADMIN | idem, sans code | arbitrage | `handoverMethod = ADMIN_OVERRIDE` | audit | — |
| LIVRER, ANNULER | * | — | — | **terminal** : tout CAS échoue | — | — | — |

## Invariants garantis par la base ou par un verrou

- **Un panier ne se paie qu'une fois** : `SELECT … FROM "Cart" FOR UPDATE` +
  relecture sous verrou (F-11) — indépendant de Redis.
- **Une commande = au plus une tentative de paiement PENDING** : index unique
  partiel `payments_order_pending_uq`.
- **Jamais deux sorties d'argent pour une commande** : reversement,
  exécution de remboursement et annulation prennent le verrou de la ligne
  `Order` (`order-row-lock.ts`, F-04).
- **Une course n'est acceptée que par son titulaire, un livreur une course à
  la fois** : CAS `status + delivererId` et `driverStatus AVAILABLE →
  ON_DELIVERY` (F-03).
- **Récompenses idempotentes** : `@@unique([orderId, type])`,
  `ReferralReward.orderId @unique`, rejouées sans risque par l'outbox.
