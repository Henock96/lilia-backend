import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DeliveriesService } from './deliveries.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryAssignmentService } from './delivery-assignment.service';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';
import { OrderTransitionService } from '../orders/order-transition.service';

/**
 * Tests de CARACTÉRISATION de l'assignation/acceptation de DeliveriesService
 * (LIL-134) : assignDeliverer, assignDelivererToOrder, acceptDelivery.
 * Fige le comportement avant extraction d'un DeliveryAssignmentService.
 */
/// Double du service de tracking : seule la purge de position est appelée
/// depuis le dispatch (à la réassignation), et elle est best-effort.
const trackingServiceDouble = {
  forgetLastPosition: jest.fn().mockResolvedValue(undefined),
};

describe('DeliveriesService (caractérisation — assignation)', () => {
  let service: DeliveriesService;

  // Depuis la séparation acceptation / récupération, les deux transitions
  // passent par un `updateMany` conditionné sur le statut lu (verrou optimiste
  // contre le double-tap), puis relisent la ligne.
  const tx = {
    delivery: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    order: { updateMany: jest.fn() },
    user: { update: jest.fn() },
    // P0-4 : toute transition de statut écrit sa ligne d'historique dans la
    // MÊME transaction. Le client de transaction doit donc l'exposer.
    orderHistory: { create: jest.fn() },
    // Journal d'assignation : ouvert et clos dans la même transaction que le
    // statut de la livraison.
    deliveryAssignment: { create: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    delivery: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(async (arg: any) =>
      Array.isArray(arg) ? Promise.all(arg) : arg(tx),
    ),
  };
  const platformSettings = { getSettings: jest.fn() };
  const notifications = { sendPushNotification: jest.fn() };
  const stateMachine = { assertTransition: jest.fn() };
  const eventEmitter = { emit: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Par défaut, le verrou optimiste réussit.
    tx.delivery.updateMany.mockResolvedValue({ count: 1 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.user.update.mockResolvedValue({});
    platformSettings.getSettings.mockResolvedValue({
      driverSharePercentLilia: 35,
      driverSharePercentIndependent: 65,
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // P0-4 : `Order.status` ne s'écrit plus qu'à travers ce service,
        // qui historise la transition dans la même transaction.
        OrderTransitionService,
        {
          provide: LoyaltyService,
          useValue: {
            awardForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          // Le parrainage est arbitré au même endroit que la fidélité depuis
          // que son déclencheur est passé du paiement à la livraison.
          provide: ReferralService,
          useValue: {
            rewardForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
          },
        },
        DeliveriesService,
        DeliveryQueryService,
        DeliveryAssignmentService, // service réel : DeliveriesService y délègue l'assignation
        { provide: PrismaService, useValue: prisma },
        // Service réel : le journal d'assignation s'écrit dans la même
        // transaction que le statut, ses écritures doivent être exercées.
        DeliveryAssignmentLogService,
        { provide: NotificationsService, useValue: notifications },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: OrderStateMachine, useValue: stateMachine },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: TrackingGateway, useValue: {} },
        { provide: TrackingService, useValue: trackingServiceDouble },
      ],
    }).compile();
    service = module.get<DeliveriesService>(DeliveriesService);
  });

  // user lookups : firebaseUid → demandeur (owner/admin) ; id → livreur cible
  //
  // Le livreur reçoit par défaut un compte actif, un profil métier actif et une
  // disponibilité : ce sont les quatre conditions qu'`assertAssignable` exige
  // depuis septembre 2026. Les tests qui veulent éprouver un refus passent
  // explicitement la valeur fautive — ainsi ce qui est testé reste lisible dans
  // le test lui-même, plutôt que caché dans une fixture partagée.
  const assignableDriver = (over: any = {}) => ({
    id: 'liv1',
    nom: 'Livreur',
    role: 'LIVREUR',
    statusUser: 'ACTIVE',
    driverStatus: 'AVAILABLE',
    driverProfile: { isActive: true },
    ...over,
  });

  const mockUsers = (requester: any, deliverer: any) => {
    const full = deliverer ? assignableDriver(deliverer) : deliverer;
    prisma.user.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where.firebaseUid ? requester : full),
    );
  };

  describe('assignDeliverer', () => {
    it('NotFound si la livraison est introuvable', async () => {
      prisma.delivery.findUnique.mockResolvedValue(null);
      await expect(
        service.assignDeliverer('d1', 'liv1', 'uid'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    /**
     * Une course qui change de mains ne garde pas l'économie de l'ancien.
     *
     * La réassignation repasse la course en `ASSIGNER` : sans effacement, la
     * ligne porterait encore le type, le taux et le montant du livreur
     * précédent — qui ne sera pas payé, puisque seul celui qui TERMINE l'est.
     * Un administrateur lisant la fiche verrait une rémunération attribuée à
     * personne, et le calcul de contribution la compterait.
     */
    it('réassignation : l’économie de l’ancien livreur est EFFACÉE', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        orderId: 'o1',
        delivererId: 'liv-A',
        status: 'ACCEPTER',
        driverPayXaf: 350,
        driverEconomicsFrozenAt: new Date(),
        order: {
          status: 'PRET',
          isPreorder: false,
          scheduledFor: null,
          restaurant: { nom: 'Resto', owner: { firebaseUid: 'uid' } },
        },
      });
      mockUsers(
        { id: 'u1', role: 'RESTAURATEUR' },
        { id: 'liv-B', role: 'LIVREUR' },
      );
      tx.delivery.findUniqueOrThrow.mockResolvedValue({
        id: 'd1',
        status: 'ASSIGNER',
      });

      await service.assignDeliverer('d1', 'liv-B', 'uid');

      const data = tx.delivery.updateMany.mock.calls[0][0].data;
      expect(data.delivererId).toBe('liv-B');
      expect(data).toMatchObject({
        driverBaseXaf: null,
        driverEmploymentType: null,
        driverCompensationModel: null,
        driverSharePercent: null,
        driverPayXaf: null,
        driverEconomicsFrozenAt: null,
      });
    });

    it('owner assigne un LIVREUR : passe la livraison en ASSIGNER + notifie', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        orderId: 'o1',
        status: 'EN_ATTENTE',
        order: {
          status: 'PRET',
          isPreorder: false,
          scheduledFor: null,
          restaurant: { nom: 'Resto', owner: { firebaseUid: 'uid' } },
        },
      });
      mockUsers(
        { id: 'u1', role: 'RESTAURATEUR' },
        { id: 'liv1', role: 'LIVREUR' },
      );
      tx.delivery.findUniqueOrThrow.mockResolvedValue({
        id: 'd1',
        status: 'ASSIGNER',
      });

      const res = await service.assignDeliverer('d1', 'liv1', 'uid');

      // L'écriture porte aussi la remise à zéro de l'économie de la course
      // (sans objet sur une première assignation, mais posée sans condition :
      // un effacement conditionnel finirait par oublier un chemin).
      expect(tx.delivery.updateMany.mock.calls[0][0].data).toEqual({
        delivererId: 'liv1',
        status: 'ASSIGNER',
        driverBaseXaf: null,
        driverEmploymentType: null,
        driverCompensationModel: null,
        driverSharePercent: null,
        driverPayXaf: null,
        driverEconomicsFrozenAt: null,
      });
      // La notification est désormais portée par `DeliveriesListener` : le
      // service se contente de décrire ce qui s'est passé.
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'delivery.assigned',
        expect.objectContaining({
          delivererId: 'liv1',
          previousDelivererId: null,
        }),
      );
      expect(res).toEqual({
        data: { id: 'd1', status: 'ASSIGNER' },
        message: 'Livreur assigné avec succès',
      });
    });

    it('réassignation : transmet l’ancien livreur pour qu’il soit libéré', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        orderId: 'o1',
        delivererId: 'liv-old',
        order: {
          restaurantId: 'resto1',
          status: 'PRET',
          restaurant: { nom: 'Resto', owner: { firebaseUid: 'uid' } },
        },
      });
      mockUsers(
        { id: 'u1', role: 'RESTAURATEUR' },
        { id: 'liv-new', role: 'LIVREUR' },
      );
      tx.delivery.findUniqueOrThrow.mockResolvedValue({
        id: 'd1',
        status: 'ASSIGNER',
      });

      const res = await service.assignDeliverer('d1', 'liv-new', 'uid');

      // Sans `previousDelivererId`, l'ancien livreur restait ON_DELIVERY à vie
      // et ne pouvait plus accepter aucune course.
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'delivery.assigned',
        expect.objectContaining({
          delivererId: 'liv-new',
          previousDelivererId: 'liv-old',
        }),
      );
      expect(res.message).toContain('réassigné');
    });

    it('refuse de réassigner au livreur déjà en place', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        orderId: 'o1',
        delivererId: 'liv1',
        order: {
          restaurantId: 'resto1',
          status: 'PRET',
          restaurant: { nom: 'Resto', owner: { firebaseUid: 'uid' } },
        },
      });
      mockUsers(
        { id: 'u1', role: 'RESTAURATEUR' },
        { id: 'liv1', role: 'LIVREUR' },
      );

      await expect(
        service.assignDeliverer('d1', 'liv1', 'uid'),
      ).rejects.toThrow('déjà assigné');
      expect(tx.delivery.updateMany).not.toHaveBeenCalled();
    });

    it('refuse une cible qui n’est pas LIVREUR', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        orderId: 'o1',
        order: {
          status: 'PRET',
          restaurant: { nom: 'Resto', owner: { firebaseUid: 'uid' } },
        },
      });
      mockUsers({ id: 'u1', role: 'ADMIN' }, { id: 'x', role: 'CLIENT' });
      await expect(
        service.assignDeliverer('d1', 'x', 'uid'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assignDelivererToOrder', () => {
    it('BadRequest si la commande n’est pas dans un statut assignable', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'ADMIN' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        status: 'EN_ATTENTE',
        restaurant: { owner: { firebaseUid: 'other' } },
      });
      await expect(
        service.assignDelivererToOrder('o1', 'liv1', 'uid'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('crée la livraison si absente puis assigne', async () => {
      // getUserOrThrow (firebaseUid) → admin ; puis lookup livreur (id)
      mockUsers({ id: 'u1', role: 'ADMIN' }, { id: 'liv1', role: 'LIVREUR' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        status: 'PRET',
        restaurant: { nom: 'Resto', owner: { firebaseUid: 'other' } },
      });
      prisma.delivery.findUnique
        .mockResolvedValueOnce(null) // pas de delivery existante
        .mockResolvedValueOnce({
          // rechargée avec relations pour _doAssign
          id: 'd1',
          orderId: 'o1',
          status: 'EN_ATTENTE',
          order: {
            status: 'PRET',
            isPreorder: false,
            scheduledFor: null,
            restaurant: { nom: 'Resto', owner: { firebaseUid: 'other' } },
          },
        });
      prisma.delivery.create.mockResolvedValue({ id: 'd1' });
      tx.delivery.findUniqueOrThrow.mockResolvedValue({
        id: 'd1',
        status: 'ASSIGNER',
      });

      const res = await service.assignDelivererToOrder('o1', 'liv1', 'uid');

      expect(prisma.delivery.create).toHaveBeenCalledWith({
        data: { orderId: 'o1', status: 'EN_ATTENTE' },
      });
      expect(res.message).toBe('Livreur assigné avec succès');
    });
  });

  describe('acceptDelivery', () => {
    const assigned = {
      id: 'd1',
      orderId: 'o1',
      delivererId: 'liv1',
      status: 'ASSIGNER',
      order: {
        status: 'PRET',
        userId: 'c1',
        restaurantId: 'r1',
        total: 5000,
        restaurant: { nom: 'Resto' },
      },
    };

    it('Forbidden si la livraison n’est pas assignée à ce livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'autre',
        driverStatus: 'AVAILABLE',
      });
      prisma.delivery.findUnique.mockResolvedValue(assigned);
      await expect(service.acceptDelivery('d1', 'uid')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('BadRequest si le livreur n’est pas AVAILABLE', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'liv1',
        driverStatus: 'ON_DELIVERY',
      });
      prisma.delivery.findUnique.mockResolvedValue(assigned);
      await expect(service.acceptDelivery('d1', 'uid')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    /**
     * Le gel économique de la course.
     *
     * ⚠️ Ce n'est PAS un snapshot « écrit une seule fois ». La politique
     * retenue est « seul le livreur qui TERMINE est payé » : si A accepte puis
     * échoue et que B livre, le snapshot doit être réécrit pour B. Le figer à
     * la première acceptation paierait B au tarif de A.
     *
     * L'immuabilité réelle vient de la machine à états : une fois la commande
     * `LIVRER`, toute réassignation est refusée, donc plus rien ne bouge.
     */
    describe('gel de l’économie de la course', () => {
      const assignedWithFee = {
        ...assigned,
        order: { ...assigned.order, deliveryFee: 0, deliveryFeeGross: 1000 },
      };

      const acceptWith = async (driverProfile: unknown) => {
        prisma.user.findUnique.mockResolvedValue({
          id: 'liv1',
          nom: 'John',
          driverStatus: 'AVAILABLE',
          driverProfile,
        });
        prisma.delivery.findUnique.mockResolvedValue(assignedWithFee);
        tx.delivery.findUniqueOrThrow.mockResolvedValue({
          ...assignedWithFee,
          status: 'ACCEPTER',
        });
        await service.acceptDelivery('d1', 'uid');
        return tx.delivery.updateMany.mock.calls[0][0].data;
      };

      it('livreur Lilia au taux plateforme : 35 % de 1 000 → 350', async () => {
        const data = await acceptWith({
          employmentType: 'LILIA',
          compensationModel: 'PER_DELIVERY',
          driverSharePercent: null,
        });

        expect(data).toMatchObject({
          driverBaseXaf: 1000,
          driverEmploymentType: 'LILIA',
          driverCompensationModel: 'PER_DELIVERY',
          driverSharePercent: 35,
          driverPayXaf: 350,
        });
        expect(data.driverEconomicsFrozenAt).toBeInstanceOf(Date);
      });

      it('livreur indépendant : 65 % de 1 000 → 650', async () => {
        const data = await acceptWith({
          employmentType: 'INDEPENDENT',
          compensationModel: 'PER_DELIVERY',
          driverSharePercent: null,
        });

        expect(data).toMatchObject({
          driverSharePercent: 65,
          driverPayXaf: 650,
        });
      });

      it('le taux propre au livreur prime', async () => {
        const data = await acceptWith({
          employmentType: 'LILIA',
          compensationModel: 'PER_DELIVERY',
          driverSharePercent: 50,
        });

        expect(data).toMatchObject({
          driverSharePercent: 50,
          driverPayXaf: 500,
        });
      });

      it('l’assiette est le tarif BRUT, pas celui après remise', async () => {
        // `deliveryFee` vaut 0 sur cette commande (livraison offerte). Payer
        // dessus ferait porter au livreur une campagne qu'il n'a pas décidée.
        const data = await acceptWith({
          employmentType: 'LILIA',
          compensationModel: 'PER_DELIVERY',
          driverSharePercent: null,
        });

        expect(assignedWithFee.order.deliveryFee).toBe(0);
        expect(data.driverBaseXaf).toBe(1000);
        expect(data.driverPayXaf).toBe(350);
      });

      it('livreur sans profil : AUCUN snapshot, et l’acceptation réussit quand même', async () => {
        // Son économie n'est pas déterminable. Écrire 0 transformerait
        // « on ne sait pas » en « il n'a rien coûté ».
        const data = await acceptWith(null);

        expect(data.status).toBe('ACCEPTER');
        expect(data.driverPayXaf).toBeUndefined();
        expect(data.driverEconomicsFrozenAt).toBeUndefined();
      });

      it('le gel est écrit dans le MÊME updateMany que le verrou de statut', async () => {
        // Deux écritures séparées laisseraient une fenêtre où la course est
        // acceptée sans économie — et un échec entre les deux la figerait ainsi.
        const data = await acceptWith({
          employmentType: 'LILIA',
          compensationModel: 'PER_DELIVERY',
          driverSharePercent: null,
        });

        expect(data.status).toBe('ACCEPTER');
        expect(data.driverPayXaf).toBe(350);
        expect(tx.delivery.updateMany).toHaveBeenCalledTimes(1);
      });
    });

    it('accepte : ACCEPTER + ON_DELIVERY, la commande NE bouge PAS', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'liv1',
        nom: 'John',
        driverStatus: 'AVAILABLE',
      });
      prisma.delivery.findUnique.mockResolvedValue(assigned);
      tx.delivery.findUniqueOrThrow.mockResolvedValue({
        id: 'd1',
        status: 'ACCEPTER',
      });

      const res = await service.acceptDelivery('d1', 'uid');

      // La livraison passe ACCEPTER, pas EN_TRANSIT.
      expect(tx.delivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'd1', status: 'ASSIGNER' },
        data: expect.objectContaining({ status: 'ACCEPTER' }),
      });
      // `pickedUpAt` n'est PAS écrit : le livreur n'a rien récupéré.
      expect(
        tx.delivery.updateMany.mock.calls[0][0].data.pickedUpAt,
      ).toBeUndefined();
      // La commande reste PRET — donc aucun « votre commande est en route ».
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'order.status.updated',
        expect.anything(),
      );
      // Seul le restaurant est prévenu.
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'delivery.accepted',
        expect.anything(),
      );
      expect(res).toEqual({ id: 'd1', status: 'ACCEPTER' });
    });

    it('double-tap : le second appel est rejeté par le verrou optimiste', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'liv1',
        driverStatus: 'AVAILABLE',
      });
      prisma.delivery.findUnique.mockResolvedValue(assigned);
      tx.delivery.updateMany.mockResolvedValue({ count: 0 }); // déjà acceptée

      await expect(service.acceptDelivery('d1', 'uid')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─── RÉCUPÉRATION DU REPAS ────────────────────────────────────────────────

  describe('confirmPickup', () => {
    const accepted = {
      id: 'd1',
      orderId: 'o1',
      delivererId: 'liv1',
      status: 'ACCEPTER',
      order: {
        status: 'PRET',
        userId: 'c1',
        restaurantId: 'r1',
        total: 5000,
        restaurant: { nom: 'Resto' },
      },
    };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'liv1',
        nom: 'John',
        driverStatus: 'ON_DELIVERY',
      });
      tx.delivery.findUniqueOrThrow.mockResolvedValue({
        id: 'd1',
        status: 'EN_TRANSIT',
      });
    });

    it('récupère : EN_TRANSIT + pickedUpAt + commande EN_ROUTE + notifie le client', async () => {
      prisma.delivery.findUnique.mockResolvedValue(accepted);

      const res = await service.confirmPickup('d1', 'uid');

      // C'est ICI que la state machine est évaluée, plus à l'acceptation.
      expect(stateMachine.assertTransition).toHaveBeenCalledWith(
        'PRET',
        'EN_ROUTE',
        'LIVREUR',
      );
      expect(tx.delivery.updateMany).toHaveBeenCalledWith({
        // Le titulaire fait partie de l'état revendiqué : réassigné entre la
        // lecture et l'écriture, l'ancien livreur n'emporte pas la course.
        where: { id: 'd1', status: 'ACCEPTER', delivererId: 'liv1' },
        data: expect.objectContaining({
          status: 'EN_TRANSIT',
          pickedUpAt: expect.any(Date),
        }),
      });
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'PRET' },
        data: { status: 'EN_ROUTE' },
      });
      // Le client est prévenu maintenant, et seulement maintenant.
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.status.updated',
        expect.anything(),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'delivery.picked_up',
        expect.anything(),
      );
      expect(res).toEqual({ id: 'd1', status: 'EN_TRANSIT' });
    });

    it('refuse une récupération sans acceptation préalable', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        ...accepted,
        status: 'ASSIGNER',
      });

      await expect(service.confirmPickup('d1', 'uid')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.delivery.updateMany).not.toHaveBeenCalled();
    });

    it('double récupération : 409, aucun second événement', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        ...accepted,
        status: 'EN_TRANSIT',
      });

      await expect(service.confirmPickup('d1', 'uid')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('Forbidden si un autre livreur tente la récupération', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'autre',
        driverStatus: 'ON_DELIVERY',
      });
      prisma.delivery.findUnique.mockResolvedValue(accepted);

      await expect(service.confirmPickup('d1', 'uid')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(tx.delivery.updateMany).not.toHaveBeenCalled();
    });

    it('commande annulée entre-temps : 409, le client n’est pas notifié', async () => {
      prisma.delivery.findUnique.mockResolvedValue(accepted);
      tx.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.confirmPickup('d1', 'uid')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
