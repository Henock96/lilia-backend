import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { DeliveryAssignmentService } from './delivery-assignment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderStateMachine } from '../orders/order-state.machine';

/**
 * Les quatre conditions d'assignabilité d'un livreur — côté ÉCRITURE.
 *
 * Elles existaient toutes dans `getAvailableDeliverers`, c'est-à-dire dans la
 * requête qui remplit la liste déroulante du vendeur. Aucune n'existait dans
 * l'opération qui écrit `delivery.delivererId`. Or les identifiants de livreurs
 * circulent — `GET /deliveries/deliverers` est ouvert à tout compte vendeur —
 * et un `PATCH` direct suffisait donc à confier une commande à un livreur
 * banni, désactivé ou hors ligne.
 *
 * **Filtrer un menu déroulant n'est pas une autorisation.** Ces tests exercent
 * la règle par l'API, pas par la liste.
 */
describe('DeliveryAssignmentService — assertAssignable', () => {
  let service: DeliveryAssignmentService;

  const prisma = {
    delivery: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    order: { findUnique: jest.fn() },
  };

  /** Livraison assignable, appartenant au vendeur dont le uid est `owner-uid`. */
  const delivery = {
    id: 'd1',
    delivererId: null,
    orderId: 'o1',
    order: {
      id: 'o1',
      restaurantId: 'r1',
      status: 'PRET',
      isPreorder: false,
      scheduledFor: null,
      restaurant: { nom: 'Chez Awa', owner: { firebaseUid: 'owner-uid' } },
    },
  };

  /** Le demandeur : le vendeur propriétaire de la commande. */
  const requester = { id: 'u-owner', role: 'RESTAURATEUR' };

  const driver = (over: Record<string, unknown> = {}) => ({
    id: 'liv1',
    nom: 'Jean',
    role: 'LIVREUR',
    statusUser: 'ACTIVE',
    driverStatus: 'AVAILABLE',
    driverProfile: { isActive: true },
    ...over,
  });

  /** `findUnique` par firebaseUid → demandeur ; par id → livreur cible. */
  const withDriver = (d: unknown) =>
    prisma.user.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where.firebaseUid ? requester : d),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.delivery.findUnique.mockResolvedValue(delivery);
    prisma.delivery.update.mockResolvedValue({
      id: 'd1',
      order: delivery.order,
      deliverer: { id: 'liv1', nom: 'Jean' },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryAssignmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: OrderStateMachine,
          useValue: { assertTransition: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(DeliveryAssignmentService);
  });

  const assign = () => service.assignDeliverer('d1', 'liv1', 'owner-uid');

  it('ACTIF + profil actif + AVAILABLE → assignable', async () => {
    withDriver(driver());
    await expect(assign()).resolves.toBeDefined();
    expect(prisma.delivery.update).toHaveBeenCalled();
  });

  it('ACTIF + profil actif + ON_DELIVERY → assignable (une 2e course est permise)', async () => {
    withDriver(driver({ driverStatus: 'ON_DELIVERY' }));
    await expect(assign()).resolves.toBeDefined();
  });

  it('ACTIF + profil actif + OFFLINE → refusé', async () => {
    withDriver(driver({ driverStatus: 'OFFLINE' }));
    await expect(assign()).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.delivery.update).not.toHaveBeenCalled();
  });

  it('compte BLOCKED → refusé, même avec un profil actif et disponible', async () => {
    withDriver(driver({ statusUser: 'BLOCKED' }));
    await expect(assign()).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.delivery.update).not.toHaveBeenCalled();
  });

  it('compte DELETED → refusé', async () => {
    withDriver(driver({ statusUser: 'DELETED' }));
    await expect(assign()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('profil métier désactivé → refusé', async () => {
    withDriver(driver({ driverProfile: { isActive: false } }));
    await expect(assign()).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.delivery.update).not.toHaveBeenCalled();
  });

  it('aucun profil métier → refusé', async () => {
    withDriver(driver({ driverProfile: null }));
    await expect(assign()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rôle CLIENT → refusé même si tout le reste est bon', async () => {
    withDriver(driver({ role: 'CLIENT' }));
    await expect(assign()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('livreur inconnu → 404', async () => {
    withDriver(null);
    await expect(assign()).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * Le message doit dire QUOI corriger. « Impossible d'assigner » renverrait
   * l'administrateur à ses hypothèses ; « n'est pas en service » lui indique
   * l'écran sur lequel aller.
   */
  it('chaque refus nomme sa cause', async () => {
    withDriver(driver({ statusUser: 'BLOCKED' }));
    await expect(assign()).rejects.toThrow(/compte BLOCKED/);

    withDriver(driver({ driverProfile: { isActive: false } }));
    await expect(assign()).rejects.toThrow(/pas en service/);

    withDriver(driver({ driverStatus: 'OFFLINE' }));
    await expect(assign()).rejects.toThrow(/hors ligne/);
  });
});
