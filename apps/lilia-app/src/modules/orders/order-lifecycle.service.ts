import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { LoyaltyTransactionType, OrderStatus, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import {
  OrderCancelledEvent,
  OrderStatusUpdatedEvent,
} from '../events/order-events';
import { OrderStateMachine } from './order-state.machine';
import { StockService } from './stock.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { RefundsService } from '../refunds/refunds.service';

/**
 * Cycle de vie d'une commande (LIL-134) : annulation, transitions de statut,
 * suppression, recommande. Extrait de `OrdersService` (devenu façade) pour
 * isoler les mutations post-création. API publique inchangée.
 */
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateMachine: OrderStateMachine,
    private readonly stockService: StockService,
    private readonly loyalty: LoyaltyService,
    private readonly refunds: RefundsService,
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
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      // Verrou optimiste (fix H6) : sans lui, une annulation client concurrente
      // d'un passage en préparation appliquait les compensations à une
      // commande toujours vivante.
      await this.claimStatus(tx, orderId, order.status, 'ANNULER');
      const updated = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: {
          restaurant: true,
          items: true, // Correction: Toujours inclure les items
        },
      });
      await this.stockService.restoreInTransaction(tx, order.items);
      await this.restoreCheckoutCompensations(tx, orderId, order.userId);
      return updated;
    });
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
   * Met à jour le statut d'une commande par un restaurateur.
   */
  async updateOrderStatusByRestaurateur(
    orderId: string,
    firebaseUid: string,
    newStatus: OrderStatus,
  ) {
    this.logger.log(
      `🔄 [STATUT] Début mise à jour - commande: ${orderId}, nouveau statut: ${newStatus}, par: ${firebaseUid}`,
    );

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

    const actor = this.resolveActor(user.role);
    if (!actor)
      throw new ForbiddenException('Acteur invalide pour cette transition');
    this.stateMachine.assertTransition(order.status, newStatus, actor);

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
    // On verrouille donc sur l'état lu (`claimStatus`), comme le fait déjà
    // `expireUnpaidOrder`.
    const updatedOrder =
      newStatus === 'ANNULER'
        ? await this.prisma.$transaction(async (tx) => {
            await this.claimStatus(tx, orderId, order.status, newStatus);
            const updated = await tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: { restaurant: true, items: true },
            });
            await this.stockService.restoreInTransaction(tx, updated.items);
            await this.restoreCheckoutCompensations(
              tx,
              orderId,
              updated.userId,
            );
            return updated;
          })
        : await this.prisma.$transaction(async (tx) => {
            await this.claimStatus(tx, orderId, order.status, newStatus);
            return tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: {
                restaurant: true,
                items: true, // Correction: Toujours inclure les items
              },
            });
          });

    // 🔥 ÉMETTRE L'ÉVÉNEMENT au lieu d'appeler directement les notifications
    const statusUpdatedEvent = new OrderStatusUpdatedEvent(
      updatedOrder.id,
      updatedOrder.userId,
      updatedOrder.restaurantId,
      order.status, // L'ancien statut (avant la mise à jour)
      newStatus, // Le nouveau statut
      user.id, // updatedBy
      {
        restaurantName: updatedOrder.restaurant.nom,
        totalAmount: updatedOrder.total,
      },
    );

    this.eventEmitter.emit('order.status.updated', statusUpdatedEvent);
    this.logger.log(
      `🔄 [STATUT] Succès: commande ${orderId} - ${order.status} → ${newStatus} (par ${user.id}/${user.role})`,
    );

    // Points fidélité quand la commande est livrée (non-bloquant)
    if (newStatus === 'LIVRER') {
      this.loyalty
        .awardForDeliveredOrder(
          updatedOrder.userId,
          orderId,
          updatedOrder.subTotal,
        )
        .catch((err) => this.logger.error(`Erreur points fidélité: ${err}`));
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
  async expireUnpaidOrder(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order || order.status !== 'EN_ATTENTE') return false;

    const expired = await this.prisma.$transaction(async (tx) => {
      // Garde de concurrence : seule l'instance qui affecte une ligne annule.
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: 'EN_ATTENTE' },
        data: { status: 'ANNULER' },
      });
      if (claimed.count === 0) return false;

      await this.stockService.restoreInTransaction(tx, order.items);
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
   * les points de fidélité consommés et l'usage du code promo.
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
  }

  /**
   * Verrou optimiste sur la transition de statut (fix H6).
   *
   * Écrit le nouveau statut **uniquement** si la commande est toujours dans
   * l'état lu au moment de la validation. Zéro ligne affectée = quelqu'un
   * d'autre a fait avancer la commande entre-temps : on refuse plutôt que
   * d'appliquer des compensations à une commande qui a changé de main.
   */
  private async claimStatus(
    tx: Prisma.TransactionClient,
    orderId: string,
    expectedStatus: OrderStatus,
    newStatus: OrderStatus,
  ): Promise<void> {
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: expectedStatus },
      data: { status: newStatus },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        'Le statut de cette commande a changé entre-temps. Rechargez-la avant de réessayer.',
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
