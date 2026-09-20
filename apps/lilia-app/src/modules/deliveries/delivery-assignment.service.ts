import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryAssignmentOutcome,
  DeliveryStatus,
  DriverStatus,
  OrderStatus,
  Role,
  StatusUser,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderTransitionService } from '../orders/order-transition.service';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { computeDriverCompensation } from '../drivers/driver-compensation';

/**
 * Remise à zéro du snapshot économique d'une course.
 *
 * Écrit en un seul endroit parce qu'un effacement PARTIEL serait pire que pas
 * d'effacement du tout : une ligne gardant `driverPayXaf` mais perdant
 * `driverEmploymentType` afficherait un montant sans pouvoir dire à qui ni à
 * quel titre. Les six colonnes vont ensemble.
 */
export const CLEARED_DRIVER_ECONOMICS = {
  driverBaseXaf: null,
  driverEmploymentType: null,
  driverCompensationModel: null,
  driverSharePercent: null,
  driverPayXaf: null,
  driverEconomicsFrozenAt: null,
} as const;
import {
  DeliveryAcceptedEvent,
  DeliveryAssignedEvent,
  DeliveryPickedUpEvent,
  DeliveryUnassignedEvent,
} from '../events/delivery-events';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { TrackingService } from '../tracking/tracking.service';

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
  OrderStatus.EN_PREPARATION,
  OrderStatus.PRET,
  OrderStatus.EN_ROUTE,
];

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
    private readonly transitions: OrderTransitionService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly assignmentLog: DeliveryAssignmentLogService,
    private readonly tracking: TrackingService,
  ) {}

  /**
   * La commande est-elle dans un état où confier une course a un sens ?
   *
   * Séparée de `assertGroundAllowsAssignment` parce qu'`assignDelivererToOrder`
   * doit pouvoir la poser **avant** de créer la ligne `Delivery` : sinon une
   * commande annulée se voyait dotée d'une livraison vide avant d'être refusée.
   */
  private assertOrderAssignable(status: OrderStatus): void {
    if (!ASSIGNABLE_ORDER_STATUSES.includes(status)) {
      throw new BadRequestException(
        `Impossible d'assigner un livreur à une commande au statut « ${status} ».`,
      );
    }
  }

  /**
   * Le terrain permet-il encore de changer de main ?
   *
   * Trois refus, et chacun protège de l'argent :
   *
   *  - **commande terminée ou annulée** — réassigner une commande `LIVRER`
   *    effaçait le snapshot économique du livreur qui l'avait livrée et
   *    attribuait sa course à un autre. Le montant dû disparaissait, et
   *    `DriverSettlementService` cessait de le voir (`payableWhere` exige
   *    `driverEconomicsFrozenAt`) ;
   *  - **course déjà livrée** — même chose, vue depuis la livraison : une
   *    commande peut être `EN_ROUTE` avec une `Delivery` en `LIVRER` le temps
   *    d'une transaction, et surtout `Order.status` ne suffit pas à décrire le
   *    terrain ;
   *  - **course déjà réglée** — le livreur a été payé pour elle. Changer son
   *    titulaire ferait couvrir par son règlement une course attribuée à
   *    quelqu'un d'autre.
   */
  private assertGroundAllowsAssignment(delivery: {
    status: DeliveryStatus;
    driverSettlementId?: string | null;
    order: { status: OrderStatus };
  }): void {
    this.assertOrderAssignable(delivery.order.status);

    if (delivery.status === DeliveryStatus.LIVRER) {
      throw new BadRequestException(
        'Cette course a été livrée : elle ne peut plus changer de livreur.',
      );
    }

    if (delivery.driverSettlementId) {
      throw new BadRequestException(
        'Cette course est déjà couverte par un règlement livreur : elle ne peut plus changer de main.',
      );
    }
  }

  private async getUserOrThrow(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      // Le profil porte l'économie de la course (type d'engagement, modèle,
      // taux). Le charger ici évite une seconde requête au moment du gel, et
      // surtout garantit qu'on lit le profil du livreur qu'on vient
      // d'authentifier — pas celui d'un identifiant passé en paramètre.
      include: {
        driverProfile: {
          select: {
            employmentType: true,
            compensationModel: true,
            driverSharePercent: true,
          },
        },
      },
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
    // Le contrôle est posé ici pour ne pas créer de `Delivery` sur une commande
    // qu'on va refuser juste après ; `_doAssign` le rejoue, il est l'arbitre.
    this.assertOrderAssignable(order.status);

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

    this.assertGroundAllowsAssignment(delivery);
    await this.assertAssignable(delivererId);

    // Livreur qui tenait la mission avant ce changement. On le mémorise
    // AVANT l'update : sans lui, une réassignation laissait l'ancien livreur
    // en `ON_DELIVERY` à vie — il ne pouvait plus accepter aucune course et
    // n'était jamais prévenu que la mission lui avait été retirée.
    const previousDelivererId: string | null = delivery.delivererId ?? null;
    const previousDeliveryStatus: DeliveryStatus = delivery.status;

    if (previousDelivererId === delivererId) {
      throw new BadRequestException(
        'Ce livreur est déjà assigné à cette livraison.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // ── Verrou optimiste ───────────────────────────────────────────────
      //
      // L'écriture était un `update` **inconditionnel**, et toutes les gardes
      // ci-dessus sont évaluées hors transaction. Deux vendeurs (ou deux
      // onglets d'administration) qui assignaient à la même seconde lisaient
      // tous deux `delivererId = null`, passaient tous deux les contrôles, et
      // la dernière écriture gagnait — en silence. Les DEUX livreurs
      // recevaient « 🚚 Nouvelle mission » ; celui qui avait perdu ne
      // l'apprenait jamais, parce que l'événement de l'autre annonçait
      // `previousDelivererId = null` et ne libérait donc personne.
      //
      // On revendique l'état **lu** : le statut ET le titulaire. Le second
      // appel ne trouve plus rien à mettre à jour et reçoit un 409.
      const claimed = await tx.delivery.updateMany({
        where: {
          id: delivery.id,
          status: previousDeliveryStatus,
          delivererId: previousDelivererId,
        },
        data: {
          delivererId,
          status: DeliveryStatus.ASSIGNER,
          // La course change de mains : l'économie du livreur précédent n'a
          // plus de titulaire. Seul celui qui TERMINE est payé — la conserver
          // ferait porter à la course une rémunération attribuée à personne,
          // que le calcul de contribution compterait et qu'un administrateur
          // lirait comme un montant dû. Le prochain livreur réécrira la sienne
          // en acceptant.
          ...CLEARED_DRIVER_ECONOMICS,
        },
      });

      if (claimed.count === 0) {
        throw new ConflictException(
          'Cette livraison vient d’être modifiée par quelqu’un d’autre. ' +
            'Rechargez la commande avant de réassigner.',
        );
      }

      // Le journal suit l'écriture dans la MÊME transaction : une trace qui
      // peut diverger de l'état qu'elle décrit ne vaut pas mieux que pas de
      // trace.
      if (previousDelivererId) {
        await this.assignmentLog.close(
          tx,
          delivery.id,
          DeliveryAssignmentOutcome.REASSIGNED,
        );
      }
      await this.assignmentLog.open(tx, {
        deliveryId: delivery.id,
        orderId: delivery.orderId,
        delivererId,
        assignedByUserId: user.id,
        assignedByRole: user.role,
      });

      return tx.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
        include: {
          deliverer: {
            select: { id: true, nom: true, phone: true, imageUrl: true },
          },
          order: true,
        },
      });
    });

    // La course change de mains : la dernière position connue appartient à
    // quelqu'un qui n'y est plus. La laisser en cache la ferait servir au
    // prochain `order:watch` du client, figée, indiscernable d'une position
    // vivante — pendant les 5 minutes du TTL.
    //
    // Après la transaction, et sans `await` : c'est un cache, son échec ne doit
    // pas défaire une réassignation. Le pire cas est le comportement d'avant.
    //
    // ⚠️ Le `catch` est **ici**, pas seulement dans `forgetLastPosition`. Une
    // promesse rejetée qu'on se contente de `void` devient un rejet non
    // capturé, et Node tue le processus — la garde interne du service ne
    // protège que tant que personne ne la retire. Un nettoyage de cache ne
    // doit jamais pouvoir faire tomber l'API.
    this.tracking.forgetLastPosition(delivery.orderId).catch(() => undefined);

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
        previousDeliveryStatus,
        delivery.order.userId,
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

    // ── Gel de l'économie de la course ────────────────────────────────────
    //
    // L'acceptation est le premier moment où un contrat se forme : le livreur
    // est connu, et il accepte un tarif. Geler plus tard laisserait un
    // changement de taux modifier ce qu'il a accepté ; geler plus tôt figerait
    // une économie sans livreur.
    //
    // ⚠️ Ce gel n'est PAS écrit une seule fois. La politique retenue est
    // « seul le livreur qui TERMINE est payé » : si ce livreur échoue et qu'un
    // autre reprend la course, le snapshot sera réécrit à SA propre
    // acceptation. Le figer définitivement ici paierait le second au tarif du
    // premier. L'immuabilité réelle vient de la machine à états — une fois la
    // commande `LIVRER`, toute réassignation est refusée.
    //
    // `null` quand le livreur n'a pas de profil : son économie n'est pas
    // déterminable, et aucune colonne n'est écrite. Le coût restera `UNKNOWN`,
    // ce qui est la vérité. Écrire 0 en ferait « il n'a rien coûté ».
    const settings = await this.platformSettings.getSettings();
    const compensation = computeDriverCompensation({
      profile: user.driverProfile,
      settings,
      // Le tarif AVANT remise : une livraison offerte par Lilia est une
      // campagne de Lilia, le livreur a roulé.
      baseXaf: delivery.order.deliveryFeeGross,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      // Verrou optimiste : les gardes ci-dessus ont été évaluées hors
      // transaction, donc un double-tap peut les franchir deux fois. Seule
      // l'écriture conditionnée sur `ASSIGNER` départage.
      //
      // Le gel voyage dans CE `updateMany`, pas dans une écriture suivante :
      // deux écritures séparées laisseraient une fenêtre où la course est
      // acceptée sans économie, et un incident entre les deux la figerait ainsi.
      const claimed = await tx.delivery.updateMany({
        where: { id: deliveryId, status: DeliveryStatus.ASSIGNER },
        data: {
          status: DeliveryStatus.ACCEPTER,
          acceptedAt: now,
          ...(compensation && {
            driverBaseXaf: compensation.baseXaf,
            driverEmploymentType: compensation.employmentType,
            driverCompensationModel: compensation.compensationModel,
            driverSharePercent: compensation.driverSharePercent,
            driverPayXaf: compensation.driverPayXaf,
            driverEconomicsFrozenAt: now,
          }),
        },
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

      // Le délai de réponse du livreur ne se déduit d'aucune colonne de
      // `Delivery` après une réassignation : `acceptedAt` y est écrasé à chaque
      // main. Il vit donc sur la ligne de journal de CETTE main.
      await this.assignmentLog.markAccepted(tx, deliveryId, now);

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

    await this.prisma.$transaction(async (tx) => {
      // Le titulaire est revendiqué en plus du statut : entre la lecture et
      // l'écriture, un vendeur a pu confier la course à quelqu'un d'autre.
      // Sans cette condition, le refus du livreur écarté effacerait le livreur
      // fraîchement assigné, qui garderait sa notification pour une mission
      // qui ne lui appartient plus.
      const claimed = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          status: DeliveryStatus.ASSIGNER,
          delivererId: user.id,
        },
        data: { status: DeliveryStatus.EN_ATTENTE, delivererId: null },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'Cette mission a changé d’état entre-temps. Rechargez vos missions.',
        );
      }

      await this.assignmentLog.close(
        tx,
        deliveryId,
        DeliveryAssignmentOutcome.DECLINED,
        reason,
      );
    });

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

    // ── Reprise après un premier livreur ──────────────────────────────────
    //
    // Une commande dont le premier livreur a échoué EN PLEINE COURSE reste
    // `EN_ROUTE` : c'est délibéré (l'échec n'annule pas la commande, le vendeur
    // arbitre). Le livreur suivant traversait alors ASSIGNER → ACCEPTER sans
    // difficulté, puis butait ici sur `EN_ROUTE → EN_ROUTE`, qui n'existe pas
    // dans la matrice. Il ne pouvait donc jamais atteindre `EN_TRANSIT` — et
    // `LIVRER` n'étant atteignable que depuis `EN_TRANSIT`, la commande
    // devenait **définitivement non livrable**. Le seul recours était un ADMIN
    // forçant `LIVRER` par `PATCH /orders/:id/status`, ce qui laissait le
    // second livreur `ON_DELIVERY` à vie et sans rémunération (son économie
    // n'ayant jamais été gelée par une transition réussie).
    //
    // La commande n'a rien à faire : elle est déjà où elle doit être. Seule la
    // livraison avance. On ne rejoue donc pas la transition — et on ne renvoie
    // pas au client un second « votre commande est en route », qu'il a déjà
    // reçu du premier livreur.
    const resumesAfterFailure = previousOrderStatus === OrderStatus.EN_ROUTE;

    if (!resumesAfterFailure) {
      this.stateMachine.assertTransition(
        previousOrderStatus,
        OrderStatus.EN_ROUTE,
        'LIVREUR',
      );
    }

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          status: DeliveryStatus.ACCEPTER,
          // Le titulaire fait partie de l'état revendiqué : réassigné entre sa
          // lecture et son écriture, l'ancien livreur ne doit pas emporter la
          // course avec lui.
          delivererId: user.id,
        },
        data: { status: DeliveryStatus.EN_TRANSIT, pickedUpAt: now },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'Cette livraison a changé d’état entre-temps. Rechargez la mission.',
        );
      }

      await this.assignmentLog.markPickedUp(tx, deliveryId, now);

      if (resumesAfterFailure) {
        // Rien à faire avancer, mais tout à vérifier : le vendeur a pu annuler
        // la commande pendant que ce second livreur était au comptoir. Sans ce
        // contrôle, la reprise serait le seul chemin vers `EN_TRANSIT` à ne
        // poser aucun verrou sur la commande.
        const stillEnRoute = await tx.order.count({
          where: { id: delivery.orderId, status: OrderStatus.EN_ROUTE },
        });
        if (stillEnRoute === 0) {
          throw new ConflictException(
            'Le statut de la commande a changé. Rechargez la mission avant de continuer.',
          );
        }
        return tx.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      }

      // Verrou optimiste sur la commande aussi : le vendeur peut l'avoir
      // annulée pendant que le livreur était au comptoir. Depuis P0-4, ce
      // verrou et l'écriture de l'historique sont un seul geste.
      const { moved } = await this.transitions.tryTransition(tx, {
        orderId: delivery.orderId,
        from: previousOrderStatus,
        to: OrderStatus.EN_ROUTE,
        actor: 'LIVREUR',
        actorUserId: user.id,
        source: 'APP',
      });
      if (!moved) {
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
    //
    // Sauf sur une reprise : aucune transition n'a eu lieu, la commande était
    // déjà `EN_ROUTE`, et le client a reçu ce message du premier livreur.
    // Émettre ici un `order.status.updated` de `EN_ROUTE` vers `EN_ROUTE`
    // annoncerait un changement qui n'a pas eu lieu — et `DeliveriesListener`
    // comme `OrdersListener` le traduiraient en push. C'est le changement de
    // livreur, et lui seul, qui est annoncé au client (`delivery.assigned`).
    if (!resumesAfterFailure) {
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
    }

    return updated;
  }
}
