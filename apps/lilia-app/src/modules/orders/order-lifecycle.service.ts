import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import {
  AdminAuditAction,
  LoyaltyTransactionType,
  OrderStatus,
  Prisma,
  VendorRejectionReason,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { releaseVendorOfferForOrder } from '../vendor-offers/vendor-offers.service';

import { PrismaService } from '../../prisma/prisma.service';
import {
  OrderCancelledEvent,
  OrderStatusUpdatedEvent,
} from '../events/order-events';
import { OrderStateMachine } from './order-state.machine';
import { OrderTransitionService } from './order-transition.service';
import {
  actorFromRole,
  DeliveryProof,
  sourceFromRole,
} from './order-transition.types';
import {
  generateHandoverCode,
  HANDOVER_MAX_ATTEMPTS,
  handoverCodeMatches,
} from '../deliveries/delivery-handover';
import { StockService, type StockMovement } from './stock.service';
import { StockSignalService } from './stock-signal.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';
import { RefundsService } from '../refunds/refunds.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  ORDER_DELIVERED_EVENT,
  ORDER_EXPIRED_EVENT,
  ORDER_REFUND_DUE_EVENT,
  ORDER_ACCEPTANCE_EXPIRED_EVENT,
} from '../outbox/outbox-events';

/**
 * Cycle de vie d'une commande (LIL-134) : annulation, transitions de statut,
 * suppression, recommande. Extrait de `OrdersService` (devenu façade) pour
 * isoler les mutations post-création. API publique inchangée.
 */
/** Refus d'une commande par le vendeur (Phase 3, F3-01). */
export interface VendorRejection {
  reason: VendorRejectionReason;
  note?: string;
  /** F3-10 — produits déclarés en rupture (motif `OUT_OF_STOCK`). */
  outOfStockProductIds?: string[];
}

/**
 * F3-10 — la marchandise est-elle encore chez le vendeur quand la commande
 * est annulée depuis ce statut ?
 *
 * Depuis `EN_ROUTE`, le livreur l'a récupérée : la remettre en stock
 * fabriquait des unités qui n'existent plus sur l'étagère (seul l'ADMIN peut
 * annuler depuis ce statut, arbitrage après incident). `ECHEC_LIVRAISON` et
 * les remboursements ne restituent pas non plus — ils ne passent pas par ici.
 */
export function goodsStillAtVendor(from: OrderStatus): boolean {
  return from !== 'EN_ROUTE';
}

@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateMachine: OrderStateMachine,
    private readonly transitions: OrderTransitionService,
    private readonly stockService: StockService,
    private readonly loyalty: LoyaltyService,
    private readonly referral: ReferralService,
    private readonly refunds: RefundsService,
    private readonly audit: AdminAuditService,
    private readonly outbox: OutboxService,
    // F3-10 — invalidation du catalogue quand une restitution change le
    // statut d'un format. En dernier : ajout sans décaler les autres.
    private readonly stockSignal: StockSignalService,
  ) {}

  async cancelOrder(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: true, items: true },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    if (order.userId !== user.id) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à annuler cette commande.",
      );
    }

    // Fix H5 : le CLIENT ne peut plus annuler une commande déjà payée —
    // l'argent est encaissé. Message explicite plutôt que l'erreur générique
    // de la state machine : le client doit savoir quoi faire ensuite.
    if (order.status !== 'EN_ATTENTE') {
      throw new ForbiddenException(
        'Cette commande est déjà payée et ne peut plus être annulée depuis ' +
          "l'application. Contactez le support pour demander un remboursement.",
      );
    }

    this.stateMachine.assertTransition(order.status, 'ANNULER', 'CLIENT');

    // Annulation + restauration du stock réservé au checkout, en une transaction
    // (sinon le stock décrémenté à la commande est perdu = stock fantôme).
    let restored: StockMovement[] = [];
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      // Verrou optimiste (fix H6) : sans lui, une annulation client concurrente
      // d'un passage en préparation appliquait les compensations à une
      // commande toujours vivante. Depuis P0-4, le verrou et l'écriture de
      // l'historique sont indissociables — même transaction, même appel.
      await this.transitions.transition(tx, {
        orderId,
        from: order.status,
        to: 'ANNULER',
        actor: 'CLIENT',
        actorUserId: user.id,
        source: 'APP',
      });
      const updated = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: {
          restaurant: true,
          items: true, // Correction: Toujours inclure les items
        },
      });
      restored = await this.stockService.restoreInTransaction(tx, order.items, {
        orderCreatedAt: order.createdAt,
      });
      await this.restoreCheckoutCompensations(tx, orderId, order.userId);
      return updated;
    });
    void this.stockSignal.announce(restored, 'restored');
    // Fix H5 : le montant remboursable n'est plus une heuristique
    // (`total >= 1000 ? total : 0`, règle écrite nulle part) mais le montant
    // réellement encaissé. `openForCancelledOrder` ne crée rien si aucun
    // paiement n'a abouti — cas nominal d'une annulation avant paiement.
    const refund = await this.refunds.openForCancelledOrder({
      orderId: order.id,
      reason: 'Annulation par le client',
      requestedBy: user.id,
    });

    const orderCancelledEvent = new OrderCancelledEvent(
      order.id,
      order.userId,
      order.restaurantId,
      'Client', // cancelledBy
      null, // cancelReason
      refund?.amount ?? 0,
    );

    this.eventEmitter.emit('order.cancelled', orderCancelledEvent);
    return updatedOrder;
  }

  /**
   * Le vendeur accepte une commande payée (Phase 3, F3-01).
   *
   * Seul chemin vers `ACCEPTEE` : il exige un temps de préparation, annoncé au
   * client (`estimatedReadyAt`). Pour une précommande, accepter vaut aussi
   * confirmer (`preorderConfirmedAt`) — un geste, pas deux.
   */
  async acceptOrder(orderId: string, firebaseUid: string, prepMinutes: number) {
    const { user, order } = await this.loadStaffOrder(orderId, firebaseUid);
    const actor = this.resolveActor(user.role);
    if (!actor)
      throw new ForbiddenException('Acteur invalide pour cette transition');
    this.stateMachine.assertTransition(order.status, 'ACCEPTEE', actor);

    const now = new Date();
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      await this.transitions.transition(tx, {
        orderId,
        from: order.status,
        to: 'ACCEPTEE',
        actor: actorFromRole(user.role) ?? 'SYSTEM',
        actorUserId: user.id,
        source: sourceFromRole(user.role),
        data: {
          acceptedAt: now,
          estimatedReadyAt: new Date(now.getTime() + prepMinutes * 60_000),
          ...(order.isPreorder ? { preorderConfirmedAt: now } : {}),
        },
      });
      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { restaurant: true, items: true },
      });
    });

    await this.announceStatusChange(
      updatedOrder,
      order.status,
      'ACCEPTEE',
      user,
    );
    return updatedOrder;
  }

  /**
   * Le vendeur refuse une commande payée ou acceptée (Phase 3, F3-01).
   *
   * Un refus EST une annulation : il passe par la même branche (stock, points,
   * promo, blocage si un reversement existe, remboursement dû écrit dans la
   * transaction). Il n'y ajoute que son motif, et marque la dette comme faute
   * vendeur — ce qui permet au remboursement de partir sans geste humain (D2).
   */
  rejectOrder(
    orderId: string,
    firebaseUid: string,
    rejection: VendorRejection,
  ) {
    return this.updateOrderStatusByRestaurateur(
      orderId,
      firebaseUid,
      'ANNULER',
      {
        rejection,
      },
    );
  }

  /**
   * Charge une commande pour un geste du personnel (vendeur ou admin).
   * Rôle, existence et propriété : partagé par toutes les routes de statut.
   */
  private async loadStaffOrder(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user || (user.role !== 'RESTAURATEUR' && user.role !== 'ADMIN')) {
      this.logger.warn(
        `🔄 [STATUT] Échec: accès refusé - user: ${firebaseUid}, rôle: ${user?.role || 'inconnu'}`,
      );
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à effectuer cette action.",
      );
    }
    this.logger.log(`🔄 [STATUT] Autorisé: ${user.id} (${user.role})`);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: true },
    });

    if (!order) {
      this.logger.warn(`🔄 [STATUT] Échec: commande ${orderId} introuvable`);
      throw new NotFoundException('Commande non trouvée.');
    }
    this.logger.log(
      `🔄 [STATUT] Commande trouvée: ${orderId}, statut actuel: ${order.status}, client: ${order.userId}, restaurant: ${order.restaurant.nom}`,
    );
    if (user.role !== 'ADMIN' && order.restaurant.ownerId !== user.id) {
      throw new ForbiddenException(
        "Cette commande n'appartient pas à votre restaurant.",
      );
    }

    return { user, order };
  }

  /**
   * Champs écrits AVEC le statut, dans le même `updateMany`.
   *
   * - refus vendeur : motif et précision ;
   * - `PAYER → EN_PREPARATION` : refusé une fois l'acceptation mise en
   *   service (il faut accepter d'abord) ; avant, acceptation implicite — les
   *   applications vendeur installées ne connaissent pas `ACCEPTEE`, et le
   *   délai de réponse reste mesurable.
   */
  private async transitionDataFor(
    from: OrderStatus,
    to: OrderStatus,
    options: { rejection?: VendorRejection },
  ): Promise<Prisma.OrderUpdateManyMutationInput | undefined> {
    if (to === 'ANNULER' && options.rejection) {
      return {
        vendorRejectionReason: options.rejection.reason,
        ...(options.rejection.note
          ? { vendorRejectionNote: options.rejection.note }
          : {}),
      };
    }
    if (from === 'PAYER' && to === 'EN_PREPARATION') {
      const settings = await this.prisma.platformSettings.findUnique({
        where: { id: 'singleton' },
        select: { orderAcceptanceRequired: true },
      });
      if (settings?.orderAcceptanceRequired) {
        throw new BadRequestException(
          'Acceptez d’abord la commande (avec un temps de préparation) avant de la préparer.',
        );
      }
      return { acceptedAt: new Date() };
    }
    return undefined;
  }

  /** Événement de changement de statut + audit d'un geste ADMIN. */
  private async announceStatusChange(
    updatedOrder: {
      id: string;
      userId: string;
      restaurantId: string;
      total: number;
      restaurant: { nom: string };
    },
    fromStatus: OrderStatus,
    newStatus: OrderStatus,
    user: { id: string; role: string },
  ): Promise<void> {
    const orderId = updatedOrder.id;
    // 🔥 ÉMETTRE L'ÉVÉNEMENT au lieu d'appeler directement les notifications
    const statusUpdatedEvent = new OrderStatusUpdatedEvent(
      updatedOrder.id,
      updatedOrder.userId,
      updatedOrder.restaurantId,
      fromStatus, // L'ancien statut (avant la mise à jour)
      newStatus, // Le nouveau statut
      user.id, // updatedBy
      {
        restaurantName: updatedOrder.restaurant.nom,
        totalAmount: updatedOrder.total,
      },
    );

    this.eventEmitter.emit('order.status.updated', statusUpdatedEvent);
    // Fix F-07 — tout geste ADMIN sur le statut d'une commande est une
    // décision d'arbitrage : il entre au journal d'audit, comme les gestes
    // sur les paiements et les remboursements. `OrderHistory` dit ce qui a
    // changé ; le journal dit qu'un administrateur l'a décidé.
    if (user.role === 'ADMIN') {
      await this.audit.record({
        actorId: user.id,
        action: AdminAuditAction.ORDER_STATUS_FORCED,
        targetType: 'Order',
        targetId: orderId,
        metadata: { from: fromStatus, to: newStatus },
      });
    }
  }

  /**
   * Met à jour le statut d'une commande par un restaurateur.
   */
  async updateOrderStatusByRestaurateur(
    orderId: string,
    firebaseUid: string,
    newStatus: OrderStatus,
    options: { rejection?: VendorRejection } = {},
  ) {
    this.logger.log(
      `🔄 [STATUT] Début mise à jour - commande: ${orderId}, nouveau statut: ${newStatus}, par: ${firebaseUid}`,
    );

    const { user, order } = await this.loadStaffOrder(orderId, firebaseUid);

    // ⚠️ Fix F-07 (Master Audit v1) — « payée » n'est pas un statut qu'on
    // déclare : c'est la conséquence d'un encaissement. Cette route laissait
    // l'ADMIN passer une commande `PAYER` sans aucune ligne `Payment` — le
    // vendeur préparait une commande que personne n'avait réglée, et le geste
    // n'apparaissait dans aucun journal d'audit. Le seul chemin est désormais
    // celui du paiement (webhook, réconciliation, ou `POST
    // /payments/:id/confirm` pour un virement manuel), qui écrit la ligne
    // `Payment` et la transition dans la même transaction.
    if (newStatus === 'PAYER') {
      throw new BadRequestException(
        'Une commande ne devient « payée » que par un paiement confirmé. ' +
          'Utilisez la confirmation du paiement, pas le changement de statut.',
      );
    }

    // F3-01 — même raisonnement : « acceptée » exige un temps de préparation,
    // que seul `POST /orders/:id/accept` porte.
    if (newStatus === 'ACCEPTEE') {
      throw new BadRequestException(
        'Pour accepter une commande, utilisez « Accepter » avec un temps de préparation.',
      );
    }

    const transitionData = await this.transitionDataFor(
      order.status,
      newStatus,
      options,
    );
    const historyReason = options.rejection
      ? `Refus vendeur : ${options.rejection.reason}` +
        (options.rejection.note ? ` — ${options.rejection.note}` : '')
      : undefined;

    const actor = this.resolveActor(user.role);
    if (!actor)
      throw new ForbiddenException('Acteur invalide pour cette transition');
    this.stateMachine.assertTransition(order.status, newStatus, actor);
    await this.assertStatusMatchesGround(order, newStatus);

    // Une annulation côté restaurateur/admin doit rendre au client exactement ce
    // qu'une annulation côté client lui rend : stock réservé, points de fidélité
    // consommés, usage du code promo. Sinon le client est pénalisé selon qui a
    // annulé — et il n'a aucune main sur ce choix.
    //
    // CONCURRENCE (fix H6, audit du 28/08/2026) : le statut était lu, validé
    // par la state machine, puis écrit avec un `update` **inconditionnel**.
    // Deux requêtes concurrentes lisaient le même état, passaient toutes deux
    // la validation, et la dernière écriture gagnait — l'admin annulait
    // pendant que le vendeur passait en préparation, et la commande restait
    // vivante alors que le stock avait été rendu et les points recrédités.
    // On verrouille donc sur l'état lu. Depuis P0-4, ce verrou vit dans
    // `OrderTransitionService` — seul point d'écriture de `Order.status` — et
    // il est indissociable de l'écriture de l'historique.
    // L'acteur a déjà été validé par la state machine ci-dessus ; `actor` ne
    // peut donc pas être `null` ici. Le contrôle reste, parce qu'un journal
    // d'audit qui invente un acteur est pire qu'un journal absent.
    const historyActor = actorFromRole(user.role) ?? 'SYSTEM';
    const historySource = sourceFromRole(user.role);

    let restored: StockMovement[] = [];
    const updatedOrder =
      newStatus === 'ANNULER'
        ? await this.prisma.$transaction(async (tx) => {
            await this.transitions.transition(tx, {
              orderId,
              from: order.status,
              to: newStatus,
              actor: historyActor,
              actorUserId: user.id,
              source: historySource,
              reason: historyReason,
              data: transitionData,
            });
            // ⚠️ Fix F-04 — l'`UPDATE` ci-dessus tient le verrou de la ligne
            // `Order`, celui que prend aussi `requestPayout` : le reversement
            // lu ici est à jour. Un vendeur déjà reversé (ou en cours de
            // l'être) ne peut plus annuler sa commande — il garderait
            // l'argent pendant que le client serait remboursé. L'ADMIN le peut
            // encore : c'est une décision d'arbitrage, et le remboursement
            // restera bloqué tant que le reversement n'est pas tranché
            // (`RefundExecutionService`).
            if (user.role !== 'ADMIN') {
              const payout = await tx.restaurantPayout.findUnique({
                where: { orderId },
                select: { status: true },
              });
              if (
                payout?.status === 'PENDING' ||
                payout?.status === 'SUCCESS'
              ) {
                throw new ConflictException(
                  'Cette commande vous a déjà été reversée (ou le reversement est en cours) : ' +
                    'vous ne pouvez plus l’annuler. Contactez le support Lilia Food.',
                );
              }
            }
            const updated = await tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: { restaurant: true, items: true },
            });
            // F3-10 — restitution du figé, sauf si la marchandise est partie
            // (EN_ROUTE) ; un refus « rupture » met à 0 les produits désignés
            // au lieu de les rendre.
            const outOfStock =
              options.rejection?.reason === 'OUT_OF_STOCK'
                ? (options.rejection.outOfStockProductIds ?? []).filter((id) =>
                    updated.items.some((item) => item.productId === id),
                  )
                : [];
            if (goodsStillAtVendor(order.status)) {
              restored = await this.stockService.restoreInTransaction(
                tx,
                updated.items,
                {
                  orderCreatedAt: updated.createdAt,
                  zeroProductIds: outOfStock,
                },
              );
            } else {
              this.logger.warn(
                `[STOCK] annulation ${orderId} depuis ${order.status} : marchandise partie, rien restitué`,
              );
            }
            if (outOfStock.length > 0) {
              await this.stockService.markOutOfStock(
                tx,
                updated.restaurantId,
                outOfStock,
              );
            }
            await this.restoreCheckoutCompensations(
              tx,
              orderId,
              updated.userId,
            );
            // Lot 4 — la dette envers le client naît AVEC l'annulation. Le
            // `.catch(log)` qui suit le commit ne suffisait pas : si le
            // processus mourait entre les deux, le remboursement n'était
            // jamais ouvert et rien ne le signalait.
            await this.outbox.enqueueInTransaction(tx, {
              type: ORDER_REFUND_DUE_EVENT,
              aggregateId: orderId,
              payload: {
                reason:
                  historyReason ?? `Annulation par ${user.role.toLowerCase()}`,
                requestedBy: user.id,
                // F3-01 / D2 — un refus vendeur ne laisse aucun doute sur la
                // dette : le remboursement peut partir sans geste humain.
                ...(options.rejection
                  ? { vendorFault: true, reasonCode: 'VENDOR_REJECTED' }
                  : {}),
              },
            });
            return updated;
          })
        : await this.prisma.$transaction(async (tx) => {
            const base = {
              orderId,
              from: order.status,
              actor: historyActor,
              actorUserId: user.id,
              source: historySource,
              reason: historyReason,
              data: transitionData,
            };
            await this.transitions.transition(
              tx,
              newStatus === 'LIVRER'
                ? {
                    ...base,
                    to: newStatus,
                    proof: staffDeliveryProof(order.isDelivery, user.role),
                  }
                : { ...base, to: newStatus },
            );
            // F3-07 / D-P5 — retrait prêt : le code que le client montrera au
            // comptoir naît avec `PRET`. Un code déjà tiré ne change pas
            // (`update: {}`) : le client a pu le noter.
            if (newStatus === 'PRET' && !order.isDelivery) {
              await tx.pickupHandover.upsert({
                where: { orderId },
                create: { orderId, code: generateHandoverCode() },
                update: {},
              });
            }
            // Lot 4 — retrait au comptoir livré : fidélité et parrainage
            // deviennent une obligation durable, écrite avec la transition.
            if (newStatus === 'LIVRER') {
              await this.outbox.enqueueInTransaction(tx, {
                type: ORDER_DELIVERED_EVENT,
                aggregateId: orderId,
                payload: {},
              });
            }
            return tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: {
                restaurant: true,
                items: true, // Correction: Toujours inclure les items
              },
            });
          });

    void this.stockSignal.announce(restored, 'restored');
    await this.announceStatusChange(
      updatedOrder,
      order.status,
      newStatus,
      user,
    );
    this.logger.log(
      `🔄 [STATUT] Succès: commande ${orderId} - ${order.status} → ${newStatus} (par ${user.id}/${user.role})`,
    );

    // Récompenses à la livraison (non-bloquantes).
    //
    // `LIVRER` est le SEUL déclencheur des deux programmes, et c'est délibéré :
    // c'est l'unique statut terminal de `ORDER_TRANSITION_MATRIX`. Tout ce qui
    // le précède — y compris `PAYER` — reste annulable avec remboursement, et
    // une récompense versée sur une commande annulable doit ou bien être
    // reprise, ou bien être offerte. On préfère ne pas la verser trop tôt.
    //
    // ⚠️ Ce bloc est dupliqué à l'identique dans `DeliveriesService.updateStatus`
    // (l'autre chemin vers LIVRER). Les deux appellent les MÊMES services, dont
    // l'idempotence est portée par la base : jouer les deux en concurrence
    // produit exactement un crédit.
    if (newStatus === 'LIVRER') {
      this.rewardDelivered(updatedOrder.userId, orderId);
    }

    // Fix H5 : une annulation vendeur/admin sur une commande déjà encaissée
    // ouvre une ligne de remboursement. C'est le seul chemin qui rend la dette
    // visible et traçable — le client, lui, ne peut plus annuler après
    // paiement (state machine).
    if (newStatus === 'ANNULER') {
      await this.refunds
        .openForCancelledOrder({
          orderId,
          reason: `Annulation par ${user.role.toLowerCase()}`,
          requestedBy: user.id,
        })
        .catch((err) =>
          this.logger.error(`Ouverture du remboursement échouée : ${err}`),
        );
    }

    return updatedOrder;
  }

  // ─── Retrait au comptoir : preuve de remise (F3-07) ────────────────────────

  /**
   * Le client confirme « J'ai récupéré ma commande » (F3-07, D-P1).
   *
   * Action du CLIENT propriétaire, et de lui seul (I-12) : la route est
   * `@Roles('CLIENT')`, et une commande qui n'est pas la sienne répond comme
   * une commande inexistante — pas d'oracle sur l'état d'une commande tierce.
   *
   *  - `PRET` : la confirmation EST la remise — `PRET → LIVRER`, preuve
   *    `PICKUP_CUSTOMER_CONFIRMED`, échéance de versement posée ;
   *  - `LIVRER` déclaré par le vendeur seul : la preuve monte, sans
   *    transition (`upgradeToCustomerConfirmed`) ;
   *  - `LIVRER` déjà prouvé (code, confirmation, admin) : rien à écrire, 200.
   *
   * Idempotent : un second appel — double tap, reprise après coupure — trouve
   * la commande déjà prouvée et ne réécrit rien (I-10). Deux appels
   * simultanés : le verrou optimiste n'en laisse passer qu'un, l'autre relit
   * et tombe dans le cas « déjà prouvé ».
   *
   * Payée : tout état au-delà de `PAYER` suppose un encaissement (fix F-07,
   * `PAYER` ne s'atteint que par un paiement confirmé) — `PRET` et `LIVRER`
   * suffisent donc à le garantir (I-13).
   */
  async confirmPickupByCustomer(
    orderId: string,
    firebaseUid: string,
  ): Promise<{ outcome: 'CONFIRMED' | 'UPGRADED' | 'ALREADY_PROVED' }> {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    const order = user
      ? await this.prisma.order.findUnique({
          where: { id: orderId },
          include: { restaurant: true },
        })
      : null;
    if (!user || !order || order.userId !== user.id) {
      throw new NotFoundException('Commande introuvable.');
    }
    if (order.isDelivery) {
      throw new ConflictException({
        message:
          'Cette commande est livrée à domicile : la remise se confirme avec le code donné au livreur.',
        code: 'PICKUP_NOT_APPLICABLE',
      });
    }

    if (order.status === 'LIVRER') return this.upgradePickupProof(order);
    if (order.status !== 'PRET') {
      throw new ConflictException(
        order.status === 'ANNULER' || order.status === 'ECHEC_LIVRAISON'
          ? {
              message: 'Cette commande est close : il n’y a rien à récupérer.',
              code: 'ORDER_CLOSED',
            }
          : {
              message:
                'Votre commande n’est pas encore prête. Vous pourrez confirmer le retrait quand le restaurant l’aura préparée.',
              code: 'PICKUP_NOT_READY',
            },
      );
    }

    this.stateMachine.assertTransition('PRET', 'LIVRER', 'CLIENT');
    try {
      await this.completePickup(order, user, 'PICKUP_CUSTOMER_CONFIRMED');
    } catch (error) {
      // Perdu la course : un second appel du même client, ou le vendeur qui
      // déclarait la remise à la même seconde. On relit et on rejoue le cas
      // `LIVRER` — la preuve monte si le vendeur l'a déclarée seul.
      if (!(error instanceof ConflictException)) throw error;
      const now = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (now?.status !== 'LIVRER') throw error;
      return this.upgradePickupProof(order);
    }
    return { outcome: 'CONFIRMED' };
  }

  /** Montée de preuve d'un retrait déjà `LIVRER` ; prévient le vendeur si elle a eu lieu. */
  private async upgradePickupProof(order: {
    id: string;
    restaurantId: string;
  }): Promise<{ outcome: 'UPGRADED' | 'ALREADY_PROVED' }> {
    const upgraded = await this.prisma.$transaction((tx) =>
      this.transitions.upgradeToCustomerConfirmed(tx, order.id),
    );
    if (!upgraded) return { outcome: 'ALREADY_PROVED' };
    this.eventEmitter.emit('order.pickup.confirmed', {
      orderId: order.id,
      restaurantId: order.restaurantId,
    });
    return { outcome: 'UPGRADED' };
  }

  /**
   * Le vendeur saisit le code que le client lui montre au comptoir (F3-07,
   * D-P5). Même règle que la remise d'une course (F-06) : chaque saisie
   * consomme un essai AVANT la comparaison (I-19), comparaison en temps
   * constant, 5 essais au plus.
   *
   * Seul chemin vers la preuve `PICKUP_CODE`, et seulement depuis `PRET`
   * (I-20) : une remise déjà déclarée ne se « rattrape » pas par un code — le
   * client peut encore la confirmer lui-même.
   */
  async handOverPickupWithCode(
    orderId: string,
    firebaseUid: string,
    providedCode: string,
  ): Promise<void> {
    const { user, order } = await this.loadStaffOrder(orderId, firebaseUid);
    // Défense en profondeur : la route est déjà `@Roles('RESTAURATEUR')`.
    // Un ADMIN qui passerait ici serait inscrit à l'historique comme le
    // vendeur ; sa clôture à lui est `PICKUP_ADMIN_OVERRIDE`, auditée.
    if (user.role !== 'RESTAURATEUR') {
      throw new ForbiddenException(
        'Seul le restaurant saisit le code de retrait du client.',
      );
    }
    if (order.isDelivery) {
      throw new ConflictException({
        message:
          'Cette commande est livrée à domicile : c’est le livreur qui saisit le code du client.',
        code: 'PICKUP_NOT_APPLICABLE',
      });
    }
    if (order.status !== 'PRET') {
      throw new ConflictException({
        message:
          order.status === 'LIVRER'
            ? 'Cette commande est déjà remise.'
            : 'La commande doit être prête avant d’être remise au client.',
        code:
          order.status === 'LIVRER'
            ? 'ORDER_ALREADY_HANDED_OVER'
            : 'PICKUP_NOT_READY',
      });
    }
    this.stateMachine.assertTransition('PRET', 'LIVRER', 'RESTAURATEUR');

    const record = await this.prisma.pickupHandover.findUnique({
      where: { orderId },
      select: { code: true },
    });
    if (!record) {
      throw new ConflictException({
        message:
          'Cette commande n’a pas de code de retrait (elle était prête avant sa mise en service). Utilisez « Remis au client ».',
        code: 'PICKUP_CODE_UNAVAILABLE',
      });
    }

    // Un essai consommé, atomiquement, AVANT de comparer.
    const consumed = await this.prisma.pickupHandover.updateMany({
      where: { orderId, attempts: { lt: HANDOVER_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (consumed.count === 0) {
      throw new ForbiddenException({
        message:
          'Trop de codes erronés. Remettez la commande sans code : le client pourra confirmer le retrait depuis son application.',
        code: 'HANDOVER_CODE_LOCKED',
      });
    }
    if (!handoverCodeMatches(record.code, providedCode)) {
      const { attempts } = await this.prisma.pickupHandover.findUniqueOrThrow({
        where: { orderId },
        select: { attempts: true },
      });
      const left = Math.max(0, HANDOVER_MAX_ATTEMPTS - attempts);
      throw new BadRequestException({
        message:
          left > 0
            ? `Code incorrect. ${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}.`
            : 'Code incorrect. Plus aucun essai : remettez la commande sans code.',
        code: 'HANDOVER_CODE_INVALID',
      });
    }

    await this.completePickup(order, user, 'PICKUP_CODE');
  }

  /**
   * `PRET → LIVRER` d'un retrait prouvé, et ses conséquences : fidélité et
   * parrainage (outbox dans la transaction, puis déclenchement immédiat),
   * annonce au client et au vendeur. Lève 409 si la commande a bougé.
   */
  private async completePickup(
    order: {
      id: string;
      userId: string;
      restaurantId: string;
      total: number;
      restaurant: { nom: string };
    },
    user: { id: string; role: string },
    proof: 'PICKUP_CODE' | 'PICKUP_CUSTOMER_CONFIRMED',
  ): Promise<void> {
    const actor = proof === 'PICKUP_CODE' ? 'RESTAURATEUR' : 'CLIENT';
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.transition(tx, {
        orderId: order.id,
        from: 'PRET',
        to: 'LIVRER',
        proof,
        actor,
        actorUserId: user.id,
        source: 'APP',
      });
      await this.outbox.enqueueInTransaction(tx, {
        type: ORDER_DELIVERED_EVENT,
        aggregateId: order.id,
        payload: {},
      });
    });
    this.logger.log(`🛍️ [RETRAIT] ${order.id} remis — preuve ${proof}`);
    await this.announceStatusChange(order, 'PRET', 'LIVRER', user);
    this.rewardDelivered(order.userId, order.id);
  }

  /**
   * Récompenses à la livraison (non bloquantes). L'idempotence est portée par
   * la base : l'outbox `order.delivered` peut rejouer sans double crédit.
   */
  private rewardDelivered(userId: string, orderId: string): void {
    this.loyalty
      .awardForDeliveredOrder(userId, orderId)
      .catch((err) => this.logger.error(`Erreur points fidélité: ${err}`));
    this.referral
      .rewardForDeliveredOrder(userId, orderId)
      .catch((err) =>
        this.logger.error(`Erreur récompense parrainage: ${err}`),
      );
  }

  /**
   * Annulation automatique d'une commande jamais payée (expiration).
   *
   * Le stock est décrémenté au checkout, pas au paiement : sans ce chemin, un
   * client qui abandonne au moment de composer `*105#` immobilise le stock
   * indéfiniment — définitivement pour les produits `stockMode = PERMANENT`,
   * que le reset quotidien ne touche pas.
   *
   * Réutilise exactement les compensations d'une annulation client (stock,
   * points de fidélité, usage du code promo) et émet `order.cancelled`, qui
   * déclenche les notifications FCM au client et au vendeur.
   *
   * Idempotent : l'`updateMany` conditionnel sur `status: EN_ATTENTE` garantit
   * qu'une commande payée entre-temps n'est jamais annulée, même si deux
   * instances Render exécutent le cron en parallèle.
   */
  /**
   * Annule une commande payée que le vendeur n'a pas acceptée avant son
   * échéance (Phase 3, F3-01).
   *
   * Même geste que l'expiration d'une commande impayée — transition SYSTÈME,
   * stock, points et promo restitués — à deux différences près : l'argent a
   * été encaissé, donc la dette de remboursement est écrite dans la même
   * transaction (`vendorFault` : elle peut partir sans humain, D2) ; et la
   * prévenance passe par l'outbox, le cron tournant dans le worker.
   *
   * Idempotent : le verrou `WHERE status = PAYER` départage une acceptation
   * arrivée à la dernière seconde — une seule des deux gagne.
   */
  async expireUnacceptedOrder(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (
      !order ||
      order.status !== 'PAYER' ||
      !order.acceptDeadlineAt ||
      order.acceptDeadlineAt.getTime() > Date.now()
    ) {
      return false;
    }

    const reason = 'Commande non acceptée par le vendeur dans le délai';
    const expired = await this.prisma.$transaction(async (tx) => {
      const { moved } = await this.transitions.tryTransition(tx, {
        orderId,
        from: 'PAYER',
        to: 'ANNULER',
        actor: 'SYSTEM',
        source: 'CRON',
        reason,
      });
      if (!moved) return false;

      await this.stockService.restoreInTransaction(tx, order.items, {
        orderCreatedAt: order.createdAt,
      });
      await this.restoreCheckoutCompensations(tx, orderId, order.userId);
      await this.outbox.enqueueInTransaction(tx, {
        type: ORDER_REFUND_DUE_EVENT,
        aggregateId: orderId,
        payload: {
          reason,
          requestedBy: null,
          vendorFault: true,
          reasonCode: 'VENDOR_TIMEOUT',
        },
      });
      await this.outbox.enqueueInTransaction(tx, {
        type: ORDER_ACCEPTANCE_EXPIRED_EVENT,
        aggregateId: orderId,
        payload: {},
      });
      return true;
    });

    if (expired) {
      this.logger.warn(
        `⏱️ Commande ${orderId} non acceptée à temps — annulée, remboursement dû`,
      );
    }
    return expired;
  }

  async expireUnpaidOrder(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order || order.status !== 'EN_ATTENTE') return false;

    const expired = await this.prisma.$transaction(async (tx) => {
      // Garde de concurrence : seule l'instance qui affecte une ligne annule.
      //
      // `tryTransition` et non `transition` : deux instances jouant le cron en
      // parallèle est le cas NOMINAL, pas une erreur. Celle qui arrive seconde
      // doit sortir en silence, pas lever un 409 dans les logs d'un cron.
      const { moved } = await this.transitions.tryTransition(tx, {
        orderId,
        from: 'EN_ATTENTE',
        to: 'ANNULER',
        actor: 'SYSTEM',
        source: 'CRON',
        reason: 'Paiement non reçu dans le délai imparti',
      });
      if (!moved) return false;

      await this.stockService.restoreInTransaction(tx, order.items, {
        orderCreatedAt: order.createdAt,
      });
      await this.restoreCheckoutCompensations(tx, orderId, order.userId);

      // Fix H2 : un `Payment` PENDING survivait à l'annulation et restait
      // listé dans `GET /admin/payments?status=PENDING`. L'admin le confirmait
      // plus tard de bonne foi et ressuscitait la commande. On clôt les
      // paiements en attente dans la même transaction.
      await tx.payment.updateMany({
        where: { orderId, status: 'PENDING' },
        data: {
          status: 'CANCELLED',
          updatedAt: new Date(),
        },
      });
      // F-10 — cette méthode tourne dans le worker, qui ne charge aucun
      // listener : l'`order.cancelled` émis plus bas n'y est entendu par
      // personne. Le client est prévenu par l'outbox.
      await this.outbox.enqueueInTransaction(tx, {
        type: ORDER_EXPIRED_EVENT,
        aggregateId: orderId,
        payload: {},
      });
      return true;
    });

    if (!expired) return false;

    this.eventEmitter.emit(
      'order.cancelled',
      new OrderCancelledEvent(
        order.id,
        order.userId,
        order.restaurantId,
        'Système',
        'Paiement non reçu dans le délai imparti',
        0, // rien n'a été encaissé : aucun remboursement
      ),
    );

    this.logger.warn(
      `⏱️ Commande ${orderId} expirée (paiement non reçu) — stock et avantages restitués`,
    );
    return true;
  }

  /**
   * Supprime (soft delete) une commande annulée pour un client.
   */
  async deleteOrder(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    if (order.userId !== user.id) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à supprimer cette commande.",
      );
    }

    if (order.status !== 'ANNULER') {
      throw new BadRequestException(
        'Seules les commandes annulées peuvent être supprimées.',
      );
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { deleteCommande: true },
    });

    return { message: 'Commande supprimée avec succès.' };
  }

  /**
   * Rend au client ce que le checkout lui avait prélevé, hors stock :
   * les points de fidélité consommés et l'usage du code promo — et au vendeur
   * le budget d'offre boutique que la commande avait consommé (F3-11).
   *
   * Sans ça, un client qui annule perd définitivement ses points ET son code
   * promo (qui reste compté contre `maxUsagePerUser` / `maxUsageTotal`).
   *
   * **Idempotent** : on re-crédite le solde NET des `LoyaltyTransaction` liées à
   * la commande. Une fois la compensation écrite, ce solde vaut 0 et un second
   * appel ne fait plus rien — important, la même commande pouvant être annulée
   * via deux chemins (client / restaurateur).
   *
   * À appeler DANS la transaction d'annulation : si l'annulation échoue, le
   * remboursement ne doit pas subsister.
   */
  private async restoreCheckoutCompensations(
    tx: Prisma.TransactionClient,
    orderId: string,
    userId: string,
  ): Promise<void> {
    // 1. Points de fidélité — solde net des mouvements liés à cette commande.
    const netPoints = await tx.loyaltyTransaction.aggregate({
      where: { orderId, userId },
      _sum: { points: true },
    });
    const pointsToRefund = -(netPoints._sum.points ?? 0);

    if (pointsToRefund > 0) {
      await tx.user.update({
        where: { id: userId },
        data: { loyaltyPoints: { increment: pointsToRefund } },
      });
      await tx.loyaltyTransaction.create({
        data: {
          userId,
          orderId,
          points: pointsToRefund,
          type: LoyaltyTransactionType.CANCELLATION_REFUND,
          reason: `+${pointsToRefund} pts — annulation commande`,
        },
      });
      this.logger.log(
        `↩️ ${pointsToRefund} points fidélité restitués au user ${userId} (commande ${orderId} annulée)`,
      );
    }

    // 2. Code promo — libère l'usage pour que le client puisse le réutiliser et
    //    que les quotas globaux redeviennent exacts.
    const removedUsages = await tx.promoUsage.deleteMany({
      where: { orderId },
    });
    if (removedUsages.count > 0) {
      this.logger.log(
        `↩️ Usage du code promo libéré (commande ${orderId} annulée)`,
      );
    }

    // 3. Offre boutique (F3-11) — le budget consommé revient au vendeur.
    const releasedXaf = await releaseVendorOfferForOrder(tx, orderId);
    if (releasedXaf > 0) {
      this.logger.log(
        `↩️ ${releasedXaf} FCFA rendus au budget de l'offre (commande ${orderId} annulée)`,
      );
    }
  }

  /**
   * Refuse un statut que la réalité ne soutient pas (audit post-correction, B-1).
   *
   * La matrice dit *qui* a le droit de faire une transition ; elle ne peut pas
   * dire si elle correspond à quelque chose sur le terrain. Or le statut d'une
   * commande n'est pas un simple libellé : chaque changement déclenche une
   * notification au client. `EN_ROUTE` lui annonce « votre livreur est en
   * chemin » — une phrase qui doit être vraie.
   *
   * Deux mensonges possibles sont fermés ici :
   *
   *  - `→ EN_ROUTE` **sans course en cours**. Le passage légitime se fait par
   *    `PATCH /deliveries/:id/pickup`, au moment où le livreur a le repas en
   *    main. Un ADMIN qui force ce statut depuis la file des commandes
   *    enverrait la notification sans que personne ne roule.
   *  - `PRET → LIVRER` **sur une commande à livrer**. Ce raccourci existe pour
   *    le retrait au comptoir ; l'appliquer à une livraison clôturerait la
   *    commande — et créditerait les points de fidélité — alors que le client
   *    n'a rien reçu.
   */
  private async assertStatusMatchesGround(
    order: { id: string; isDelivery: boolean; status: OrderStatus },
    newStatus: OrderStatus,
  ): Promise<void> {
    // F3-05 — un échec de livraison se conclut avec un responsable, qui décide
    // du remboursement, du reversement et de la paie. Le changement de statut
    // générique n'en sait rien : il ne peut pas y conduire.
    if (newStatus === 'ECHEC_LIVRAISON') {
      throw new BadRequestException(
        "Un échec de livraison se conclut depuis l'arbitrage (POST /admin/orders/:id/conclude-failure), avec un responsable.",
      );
    }
    if (newStatus === 'EN_ROUTE') {
      const enTransit = await this.prisma.delivery.findFirst({
        where: { orderId: order.id, status: 'EN_TRANSIT' },
        select: { id: true },
      });

      if (!enTransit) {
        throw new BadRequestException(
          'Cette commande ne peut pas être marquée « en route » : aucun livreur ' +
            "ne l'a récupérée. Le passage se fait quand le livreur confirme la " +
            'récupération depuis son application.',
        );
      }
      return;
    }

    // Uniquement le raccourci comptoir. Depuis `EN_ROUTE`, la clôture reste
    // ouverte à l'ADMIN : la course a bien eu lieu, il ne fait que constater
    // une fin que le livreur n'a pas enregistrée.
    if (newStatus === 'LIVRER' && order.status === 'PRET' && order.isDelivery) {
      throw new BadRequestException(
        'Cette commande doit être livrée : seul le livreur peut la marquer comme ' +
          'livrée, une fois la course terminée. Le passage direct est réservé aux ' +
          'commandes à emporter.',
      );
    }
  }

  private resolveActor(
    role: string,
  ): 'CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR' | null {
    const map: Record<string, any> = {
      CLIENT: 'CLIENT',
      RESTAURATEUR: 'RESTAURATEUR',
      ADMIN: 'ADMIN',
      LIVREUR: 'LIVREUR',
    };
    return map[role] ?? null;
  }
}

/**
 * Preuve d'une clôture par le personnel via la route de statut (F3-07).
 *
 * Le vendeur qui déclare seul la remise d'un retrait ne prouve rien : c'est
 * `PICKUP_VENDOR_DECLARED`, sans versement automatique (D-P1). Le code saisi
 * au comptoir et la confirmation du client ont leurs propres routes.
 * L'ADMIN, lui, arbitre — audité par `announceStatusChange`.
 */
export function staffDeliveryProof(
  isDelivery: boolean,
  role: string,
): DeliveryProof {
  if (isDelivery) return 'DELIVERY_ADMIN_OVERRIDE';
  return role === 'ADMIN' ? 'PICKUP_ADMIN_OVERRIDE' : 'PICKUP_VENDOR_DECLARED';
}
