import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryStatus,
  DriverStatus,
  OrderStatus,
  Role,
  StatusUser,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import {
  DeliveryAcceptedEvent,
  DeliveryAssignedEvent,
  DeliveryPickedUpEvent,
  DeliveryUnassignedEvent,
} from '../events/delivery-events';

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

  /**
   * Quatre conditions pour qu'une course puisse être confiée à quelqu'un.
   *
   * Elles étaient toutes présentes dans `getAvailableDeliverers` — c'est-à-dire
   * dans la **lecture** qui alimente la liste déroulante — et aucune dans
   * l'**écriture**. Un `delivererId` connu (ils circulent : la liste
   * d'assignation est ouverte à tout compte vendeur) permettait donc de confier
   * une commande à un livreur banni, désactivé ou hors ligne, par un simple
   * appel HTTP direct. Filtrer un menu déroulant n'est pas une autorisation.
   *
   * Les trois notions restent distinctes, et chacune a son message : un
   * administrateur qui voit « profil désactivé » sait quoi faire, un
   * « impossible d'assigner » ne dit rien.
   */
  private async assertAssignable(delivererId: string): Promise<void> {
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: {
        nom: true,
        role: true,
        statusUser: true,
        driverStatus: true,
        driverProfile: { select: { isActive: true } },
      },
    });

    if (!deliverer) throw new NotFoundException('Livreur non trouvé.');

    if (deliverer.role !== Role.LIVREUR) {
      throw new ForbiddenException(
        "L'utilisateur sélectionné n'est pas un livreur.",
      );
    }

    const qui = deliverer.nom ?? 'Ce livreur';

    if (deliverer.statusUser !== StatusUser.ACTIVE) {
      throw new ForbiddenException(
        `${qui} a un compte ${deliverer.statusUser} : il ne peut pas recevoir de course.`,
      );
    }

    // Un livreur sans profil ne peut plus exister depuis la migration du
    // 03/09 (elle en a rétro-créé un pour chaque compte existant). Le cas
    // reste traité : une écriture hors application pourrait en fabriquer un,
    // et l'assignation est le dernier endroit où l'on peut encore refuser.
    if (!deliverer.driverProfile) {
      throw new ForbiddenException(
        `${qui} n'a pas de profil livreur. Complétez sa fiche avant de lui confier une course.`,
      );
    }

    if (!deliverer.driverProfile.isActive) {
      throw new ForbiddenException(
        `${qui} n'est pas en service. Activez son profil avant de lui confier une course.`,
      );
    }

    if (deliverer.driverStatus === DriverStatus.OFFLINE) {
      throw new ForbiddenException(
        `${qui} est hors ligne. Choisissez un livreur disponible.`,
      );
    }
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
  async assignDelivererToOrder(
    orderId: string,
    delivererId: string,
    firebaseUid: string,
  ) {
    const user = await this.getUserOrThrow(firebaseUid);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: { include: { owner: true } } },
    });

    if (!order) throw new NotFoundException('Commande non trouvée.');

    const isRestaurantOwner =
      order.restaurant.owner.firebaseUid === firebaseUid;
    const isAdmin = user.role === 'ADMIN';
    if (!isRestaurantOwner && !isAdmin) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à assigner un livreur à cette commande.",
      );
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
    let delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
    });
    if (!delivery) {
      delivery = await this.prisma.delivery.create({
        data: { orderId, status: 'EN_ATTENTE' },
      });
    }

    // Recharger avec les relations nécessaires à _doAssign
    const deliveryFull = await this.prisma.delivery.findUnique({
      where: { id: delivery.id },
      include: {
        order: { include: { restaurant: { include: { owner: true } } } },
      },
    });

    return this._doAssign(deliveryFull!, delivererId, firebaseUid);
  }

  private async _doAssign(
    delivery: any,
    delivererId: string,
    firebaseUid: string,
  ) {
    const user = await this.getUserOrThrow(firebaseUid);
    const isRestaurantOwner =
      delivery.order.restaurant.owner.firebaseUid === firebaseUid;
    const isAdmin = user.role === 'ADMIN';

    if (!isRestaurantOwner && !isAdmin) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à assigner un livreur à cette livraison.",
      );
    }

    await this.assertAssignable(delivererId);

    // Livreur qui tenait la mission avant ce changement. On le mémorise
    // AVANT l'update : sans lui, une réassignation laissait l'ancien livreur
    // en `ON_DELIVERY` à vie — il ne pouvait plus accepter aucune course et
    // n'était jamais prévenu que la mission lui avait été retirée.
    const previousDelivererId: string | null = delivery.delivererId ?? null;

    if (previousDelivererId === delivererId) {
      throw new BadRequestException(
        'Ce livreur est déjà assigné à cette livraison.',
      );
    }

    const updated = await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { delivererId, status: DeliveryStatus.ASSIGNER },
      include: {
        deliverer: {
          select: { id: true, nom: true, phone: true, imageUrl: true },
        },
        order: true,
      },
    });

    // Note: dépend de Prisma include sur order (cf. assignDeliverer / assignDelivererToOrder)
    // pour que isPreorder/scheduledFor arrivent. Ne pas narrow avec un select sans les ajouter.
    const isPreorder = delivery.order.isPreorder ?? false;
    const scheduledFor = delivery.order.scheduledFor;

    // Les notifications (nouveau livreur + libération de l'ancien) sont
    // portées par `DeliveriesListener`, comme pour les commandes.
    this.eventEmitter.emit(
      'delivery.assigned',
      new DeliveryAssignedEvent(
        updated.id,
        delivery.orderId,
        delivery.order.restaurantId,
        delivererId,
        delivery.order.restaurant.nom,
        delivery.order.status,
        isPreorder,
        scheduledFor ?? null,
        previousDelivererId,
      ),
    );

    return {
      data: updated,
      message: previousDelivererId
        ? 'Livreur réassigné — le précédent a été libéré'
        : 'Livreur assigné avec succès',
    };
  }

  /**
   * Le livreur accepte la mission.
   *
   * ⚠️ Accepter une mission ≠ être en route vers le client.
   *
   * Cette méthode faisait auparavant passer la livraison directement en
   * `EN_TRANSIT`, écrivait `pickedUpAt`, basculait la commande en `EN_ROUTE` et
   * émettait `order.status.updated` — ce qui déclenchait le « 🛵 votre livreur
   * est en chemin » côté client à la seconde où le livreur appuyait sur
   * « Accepter », alors qu'il n'avait même pas quitté son domicile. Et
   * `pickedUpAt`, dont le sens est « quand le livreur a pris la commande »,
   * était donc faux en base.
   *
   * Elle ne fait plus que ce qu'elle dit : `ASSIGNER → ACCEPTER` et le livreur
   * passe `ON_DELIVERY`. La commande, elle, reste `PRET` — c'est
   * `confirmPickup` qui la fera avancer.
   */
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
    if (delivery.status !== DeliveryStatus.ASSIGNER) {
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
          ? "Vous avez déjà une livraison en cours. Terminez-la avant d'en accepter une autre."
          : 'Vous devez être disponible pour accepter une livraison.',
      );
    }

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      // Verrou optimiste : les gardes ci-dessus ont été évaluées hors
      // transaction, donc un double-tap peut les franchir deux fois. Seule
      // l'écriture conditionnée sur `ASSIGNER` départage.
      const claimed = await tx.delivery.updateMany({
        where: { id: deliveryId, status: DeliveryStatus.ASSIGNER },
        data: { status: DeliveryStatus.ACCEPTER, acceptedAt: now },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'Cette mission a déjà été acceptée ou vous a été retirée.',
        );
      }

      await tx.user.update({
        where: { id: user.id },
        data: { driverStatus: DriverStatus.ON_DELIVERY },
      });

      return tx.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    });

    // Seul le RESTAURANT est prévenu : il sait qu'un livreur vient chercher la
    // commande. Le client, lui, n'a rien de nouveau à apprendre tant que le
    // repas n'a pas quitté le comptoir.
    this.eventEmitter.emit(
      'delivery.accepted',
      new DeliveryAcceptedEvent(
        delivery.id,
        delivery.orderId,
        delivery.order.restaurantId,
        user.id,
        user.nom,
      ),
    );

    return updated;
  }

  /**
   * Le livreur refuse la mission qui lui a été confiée.
   *
   * Sans ce chemin, il n'avait que deux options : ignorer la mission — qui
   * restait alors `ASSIGNER` indéfiniment, sans que le vendeur l'apprenne — ou
   * accepter puis « signaler un échec », qui trace un incident
   * `DRIVER_NO_SHOW` de sévérité HIGH. Refuser poliment une course n'est ni
   * un abandon ni un incident.
   *
   * La livraison redevient assignable (`EN_ATTENTE`, sans livreur) et le
   * vendeur est prévenu qu'il doit en désigner un autre.
   */
  async declineDelivery(
    deliveryId: string,
    firebaseUid: string,
    reason?: string,
  ) {
    const user = await this.getUserOrThrow(firebaseUid);
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { order: { select: { restaurantId: true } } },
    });

    if (!delivery) throw new NotFoundException('Livraison introuvable.');
    if (delivery.delivererId !== user.id) {
      throw new ForbiddenException('Cette livraison ne vous est pas assignée');
    }

    // On ne refuse que ce qu'on n'a pas encore pris en charge. Après
    // acceptation, le livreur s'est engagé : le chemin est « signaler un
    // échec », qui prévient le client et trace l'incident.
    if (delivery.status !== DeliveryStatus.ASSIGNER) {
      throw new BadRequestException(
        delivery.status === DeliveryStatus.ACCEPTER
          ? 'Vous avez déjà accepté cette mission. Signalez un échec si vous ne pouvez plus la faire.'
          : 'Cette mission ne peut plus être refusée.',
      );
    }

    const claimed = await this.prisma.delivery.updateMany({
      where: { id: deliveryId, status: DeliveryStatus.ASSIGNER },
      data: { status: DeliveryStatus.EN_ATTENTE, delivererId: null },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        'Cette mission a changé d’état entre-temps. Rechargez vos missions.',
      );
    }

    this.eventEmitter.emit(
      'delivery.unassigned',
      new DeliveryUnassignedEvent(
        delivery.id,
        delivery.orderId,
        delivery.order.restaurantId,
        user.id,
        'declined',
        reason?.trim() || null,
      ),
    );

    return { message: 'Mission refusée. Elle est de nouveau assignable.' };
  }

  /**
   * Le livreur confirme avoir **récupéré le repas** et part vers le client.
   *
   * C'est le seul point du système où l'on sait avec certitude que le livreur a
   * la commande en main. D'où trois effets, et eux seuls ici :
   *  - `ACCEPTER → EN_TRANSIT` (état qui conditionne déjà le tracking GPS) ;
   *  - `pickedUpAt` enfin écrit au bon moment ;
   *  - `Order PRET → EN_ROUTE`, ce qui déclenche le « votre commande est en
   *    route » côté client via `order.status.updated`.
   */
  async confirmPickup(deliveryId: string, firebaseUid: string) {
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
    if (delivery.status === DeliveryStatus.EN_TRANSIT) {
      throw new ConflictException(
        'Vous avez déjà confirmé la récupération de cette commande.',
      );
    }
    if (delivery.status !== DeliveryStatus.ACCEPTER) {
      throw new BadRequestException(
        'Vous devez accepter la mission avant de récupérer la commande.',
      );
    }

    // La commande doit être prête : on ne récupère pas un plat qui n'existe
    // pas encore. La state machine porte déjà la règle PRET → EN_ROUTE par un
    // LIVREUR — c'est ICI qu'elle devait être évaluée, pas à l'acceptation.
    const previousOrderStatus = delivery.order.status;
    this.stateMachine.assertTransition(
      previousOrderStatus,
      OrderStatus.EN_ROUTE,
      'LIVREUR',
    );

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.delivery.updateMany({
        where: { id: deliveryId, status: DeliveryStatus.ACCEPTER },
        data: { status: DeliveryStatus.EN_TRANSIT, pickedUpAt: now },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'Cette livraison a changé d’état entre-temps. Rechargez la mission.',
        );
      }

      // Verrou optimiste sur la commande aussi : le vendeur peut l'avoir
      // annulée pendant que le livreur était au comptoir.
      const orderClaimed = await tx.order.updateMany({
        where: { id: delivery.orderId, status: previousOrderStatus },
        data: { status: OrderStatus.EN_ROUTE },
      });
      if (orderClaimed.count === 0) {
        throw new ConflictException(
          'Le statut de la commande a changé. Rechargez la mission avant de continuer.',
        );
      }

      return tx.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    });

    // 1. Le restaurant sait que le repas est parti de chez lui.
    this.eventEmitter.emit(
      'delivery.picked_up',
      new DeliveryPickedUpEvent(
        delivery.id,
        delivery.orderId,
        delivery.order.restaurantId,
        user.id,
        user.nom,
        delivery.order.userId,
      ),
    );

    // 2. Le client reçoit « votre commande est en route » — maintenant, et
    // seulement maintenant.
    this.eventEmitter.emit(
      'order.status.updated',
      new OrderStatusUpdatedEvent(
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
      ),
    );

    return updated;
  }
}
