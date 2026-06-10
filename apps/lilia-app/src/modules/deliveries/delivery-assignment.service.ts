import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DriverStatus, OrderStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import { DeliveryStatus } from './dto/update-delivery.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderStatusUpdatedEvent } from '../events/order-events';

/**
 * Assignation et acceptation de livraisons (LIL-134).
 *
 * Extrait de `DeliveriesService` : assignation d'un livreur (par livraison ou
 * par commande, avec création de la livraison si besoin) et acceptation par le
 * livreur (PRET → EN_ROUTE). `DeliveriesService` y délègue — API inchangée.
 */
@Injectable()
export class DeliveryAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateMachine: OrderStateMachine,
  ) {}

  private async getUserOrThrow(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }
    return user;
  }

  async assignDeliverer(id: string, delivererId: string, firebaseUid: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        order: { include: { restaurant: { include: { owner: true } } } },
      },
    });

    if (!delivery) {
      throw new NotFoundException(`Livraison avec l'ID "${id}" non trouvée.`);
    }

    return this._doAssign(delivery, delivererId, firebaseUid);
  }

  /**
   * Assigne un livreur via l'ID de commande (crée la livraison si elle n'existe pas)
   */
  async assignDelivererToOrder(orderId: string, delivererId: string, firebaseUid: string) {
    const user = await this.getUserOrThrow(firebaseUid);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: { include: { owner: true } } },
    });

    if (!order) throw new NotFoundException('Commande non trouvée.');

    const isRestaurantOwner = order.restaurant.owner.firebaseUid === firebaseUid;
    const isAdmin = user.role === 'ADMIN';
    if (!isRestaurantOwner && !isAdmin) {
      throw new ForbiddenException("Vous n'êtes pas autorisé à assigner un livreur à cette commande.");
    }

    // Un livreur ne peut être assigné que sur une commande payée et en cours de
    // traitement — pas sur EN_ATTENTE (non payée) ni sur une commande terminée.
    const assignableStatuses: OrderStatus[] = [
      OrderStatus.PAYER,
      OrderStatus.EN_PREPARATION,
      OrderStatus.PRET,
      OrderStatus.EN_ROUTE,
    ];
    if (!assignableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Impossible d'assigner un livreur à une commande au statut « ${order.status} ».`,
      );
    }

    // Trouver ou créer l'enregistrement Delivery
    let delivery = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (!delivery) {
      delivery = await this.prisma.delivery.create({
        data: { orderId, status: 'EN_ATTENTE' },
      });
    }

    // Recharger avec les relations nécessaires à _doAssign
    const deliveryFull = await this.prisma.delivery.findUnique({
      where: { id: delivery.id },
      include: { order: { include: { restaurant: { include: { owner: true } } } } },
    });

    return this._doAssign(deliveryFull!, delivererId, firebaseUid);
  }

  private async _doAssign(
    delivery: any,
    delivererId: string,
    firebaseUid: string,
  ) {
    const user = await this.getUserOrThrow(firebaseUid);
    const isRestaurantOwner = delivery.order.restaurant.owner.firebaseUid === firebaseUid;
    const isAdmin = user.role === 'ADMIN';

    if (!isRestaurantOwner && !isAdmin) {
      throw new ForbiddenException("Vous n'êtes pas autorisé à assigner un livreur à cette livraison.");
    }

    const deliverer = await this.prisma.user.findUnique({ where: { id: delivererId } });
    if (!deliverer) throw new NotFoundException('Livreur non trouvé.');
    if (deliverer.role !== 'LIVREUR') {
      throw new ForbiddenException("L'utilisateur sélectionné n'est pas un livreur.");
    }

    const updated = await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { delivererId, status: DeliveryStatus.ASSIGNER },
      include: {
        deliverer: { select: { id: true, nom: true, phone: true, imageUrl: true } },
        order: true,
      },
    });

    // Note: dépend de Prisma include sur order (cf. assignDeliverer / assignDelivererToOrder)
    // pour que isPreorder/scheduledFor arrivent. Ne pas narrow avec un select sans les ajouter.
    const isPreorder = delivery.order.isPreorder ?? false;
    const scheduledFor = delivery.order.scheduledFor;

    await this.notificationsService.sendPushNotification(
      deliverer.id,
      isPreorder && scheduledFor
        ? '📅 Pré-commande à récupérer le ' + this.formatScheduledForFr(scheduledFor)
        : '🚚 Nouvelle mission',
      `Commande à récupérer chez ${delivery.order.restaurant.nom}`,
      {
        type: 'delivery_assigned',
        deliveryId: updated.id,
        orderId: delivery.orderId,
        isPreorder: String(isPreorder),
        scheduledFor: scheduledFor?.toISOString() ?? '',
      },
    );

    return { data: updated, message: 'Livreur assigné avec succès' };
  }

  async acceptDelivery(deliveryId: string, firebaseUid: string) {
    const user = await this.getUserOrThrow(firebaseUid);
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        order: { include: { restaurant: { select: { nom: true } } } },
      },
    });

    if (!delivery) throw new NotFoundException('Livraison introuvable.');
    if (delivery.delivererId !== user.id) {
      throw new ForbiddenException('Cette livraison ne vous est pas assignée');
    }
    if (delivery.status !== 'ASSIGNER') {
      throw new BadRequestException('Livraison déjà acceptée ou non assignée');
    }
    // Un livreur déjà en course ne peut pas en accepter une 2e (sinon les
    // positions de tracking des deux commandes seraient confondues).
    // SÉCURITÉ (fix B5) : un livreur ne peut accepter une nouvelle livraison
    // que s'il est AVAILABLE. ON_DELIVERY = course en cours, OFFLINE = pas
    // en service. Sans ce check, un livreur pouvait tenir deux missions
    // simultanées et bloquer le tracking côté client.
    if (user.driverStatus !== DriverStatus.AVAILABLE) {
      throw new BadRequestException(
        user.driverStatus === DriverStatus.ON_DELIVERY
          ? 'Vous avez déjà une livraison en cours. Terminez-la avant d\'en accepter une autre.'
          : 'Vous devez être disponible pour accepter une livraison.',
      );
    }

    // Valide la transition Order PRET → EN_ROUTE via state machine
    this.stateMachine.assertTransition(
      delivery.order.status,
      OrderStatus.EN_ROUTE,
      'LIVREUR',
    );

    const previousOrderStatus = delivery.order.status;
    const now = new Date();

    // Met à jour livraison + statut livreur + commande en transaction
    const [updated] = await this.prisma.$transaction([
      this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'EN_TRANSIT', pickedUpAt: now },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { driverStatus: 'ON_DELIVERY' },
      }),
      this.prisma.order.update({
        where: { id: delivery.orderId },
        data: { status: OrderStatus.EN_ROUTE },
      }),
    ]);

    // Notifie le client que le livreur est en route — payload structuré
    const statusEvent = new OrderStatusUpdatedEvent(
      delivery.orderId,
      delivery.order.userId,
      delivery.order.restaurantId,
      previousOrderStatus,
      OrderStatus.EN_ROUTE,
      user.id,
      {
        restaurantName: delivery.order.restaurant.nom,
        totalAmount: delivery.order.total,
      },
    );
    this.eventEmitter.emit('order.status.updated', statusEvent);

    return updated;
  }

  private formatScheduledForFr(d: Date): string {
    // scheduledFor est stocké en UTC. Le serveur Render tourne en UTC.
    // Brazzaville = WAT = UTC+1. On décale explicitement puis on lit
    // les composantes UTC pour avoir l'heure locale Congo.
    const wat = new Date(d.getTime() + 60 * 60 * 1000);
    const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const dayName = days[wat.getUTCDay()].charAt(0).toUpperCase() + days[wat.getUTCDay()].slice(1);
    const hh = wat.getUTCHours().toString().padStart(2, '0');
    const mm = wat.getUTCMinutes().toString().padStart(2, '0');
    return `${dayName} ${wat.getUTCDate()} ${months[wat.getUTCMonth()]} à ${hh}:${mm}`;
  }
}
