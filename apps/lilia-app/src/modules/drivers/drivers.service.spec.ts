import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { DriversService } from './drivers.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { UserCacheService } from '../auth/services/user-cache.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import { CreateDriverDto } from './dto/driver.dto';

/**
 * Création et cycle de vie d'un compte livreur.
 *
 * Avant septembre 2026, aucune de ces opérations n'existait : mettre un livreur
 * en service supposait de lui faire créer un compte CLIENT dans l'application
 * grand public, puis d'appeler `PATCH /admin/users/:id/role` depuis un client
 * HTTP. Ces tests fixent le comportement du chemin qui remplace ce bricolage.
 */
describe('DriversService', () => {
  let service: DriversService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    driverProfile: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    delivery: { findFirst: jest.fn(), findMany: jest.fn() },
    deliveryReview: { aggregate: jest.fn() },
    quartier: { count: jest.fn() },
    $transaction: jest.fn(),
  };

  const firebase = {
    createUser: jest.fn(),
    getAuth: jest.fn(() => ({ deleteUser: jest.fn() })),
  };
  const audit = { record: jest.fn() };
  const userCache = { invalidate: jest.fn() };

  const baseDto: CreateDriverDto = {
    email: 'Jean.Mabiala@Example.CG',
    nom: 'Jean Mabiala',
    phone: '061234567',
    vehicleType: 'MOTO' as never,
    plateNumber: 'BZV-1234',
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma.$transaction.mockImplementation((cb: any) => cb(prisma));
    prisma.user.create.mockResolvedValue({ id: 'u-new' });
    prisma.driverProfile.create.mockResolvedValue({ id: 'p-new' });
    prisma.quartier.count.mockResolvedValue(0);
    firebase.createUser.mockResolvedValue('fb-new');

    // `findOne` est rappelé en fin de création pour rendre la fiche complète.
    prisma.delivery.findMany.mockResolvedValue([]);
    prisma.delivery.findFirst.mockResolvedValue(null);
    prisma.deliveryReview.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { _all: 0 },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriversService,
        { provide: PrismaService, useValue: prisma },
        { provide: FirebaseService, useValue: firebase },
        { provide: AdminAuditService, useValue: audit },
        { provide: UserCacheService, useValue: userCache },
        {
          provide: PaginationService,
          useValue: { getPaginationMeta: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(DriversService);
  });

  // ─── Création ──────────────────────────────────────────────────────────────

  describe('createDriver', () => {
    /** Le cas nominal : un User ET un DriverProfile, dans une transaction. */
    it('crée le User, le DriverProfile et pose role = LIVREUR', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // contrôle e-mail
        .mockResolvedValue({ id: 'u-new', role: 'LIVREUR', driverProfile: {} });

      await service.createDriver(baseDto, 'admin-1');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: 'LIVREUR',
            email: 'jean.mabiala@example.cg', // normalisé en minuscules
            driverStatus: 'OFFLINE',
          }),
        }),
      );
      expect(prisma.driverProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'u-new', isActive: false }),
        }),
      );
    });

    /**
     * Créer un livreur et l'autoriser à prendre des courses sont deux
     * décisions : la seconde suppose d'avoir vu ses papiers.
     */
    it('le profil naît INACTIF — l’activation est un geste séparé', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'u-new', role: 'LIVREUR' });

      await service.createDriver(baseDto, 'admin-1');

      expect(prisma.driverProfile.create.mock.calls[0][0].data.isActive).toBe(
        false,
      );
    });

    /**
     * L'administrateur ne choisit jamais le mot de passe : il ne doit pas avoir
     * à le transmettre par un canal qu'il ne maîtrise pas.
     */
    it('le mot de passe Firebase est jetable et n’est jamais rendu', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'u-new', role: 'LIVREUR' });

      const res = await service.createDriver(baseDto, 'admin-1');

      const password = firebase.createUser.mock.calls[0][0].password as string;
      expect(password.length).toBeGreaterThanOrEqual(32);
      expect(JSON.stringify(res)).not.toContain(password);
    });

    it('e-mail déjà pris → 409 nommant le rôle du compte existant', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u-x',
        role: 'CLIENT',
      });
      await expect(service.createDriver(baseDto, 'admin-1')).rejects.toThrow(
        /déjà un compte CLIENT/,
      );
      expect(firebase.createUser).not.toHaveBeenCalled();
    });

    /**
     * Sans ce rollback, l'adresse resterait réservée côté Firebase et toute
     * nouvelle tentative échouerait en « e-mail déjà utilisé », sans que rien
     * n'indique pourquoi.
     */
    it('transaction en échec → le compte Firebase est supprimé', async () => {
      const deleteUser = jest.fn();
      firebase.getAuth.mockReturnValue({ deleteUser } as never);
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.$transaction.mockRejectedValue(new Error('boom'));

      await expect(service.createDriver(baseDto, 'admin-1')).rejects.toThrow(
        'boom',
      );
      expect(deleteUser).toHaveBeenCalledWith('fb-new');
    });

    // ─── Cohérence véhicule / plaque ────────────────────────────────────────

    it('MOTO sans plaque → 400', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.createDriver({ ...baseDto, plateNumber: undefined }, 'a'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('VELO avec plaque → 400 (un vélo n’a pas d’immatriculation)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.createDriver(
          { ...baseDto, vehicleType: 'VELO' as never, plateNumber: 'X-1' },
          'a',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('PIETON sans plaque → accepté', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'u-new', role: 'LIVREUR' });
      await expect(
        service.createDriver(
          {
            ...baseDto,
            vehicleType: 'PIETON' as never,
            plateNumber: undefined,
          },
          'a',
        ),
      ).resolves.toBeDefined();
    });

    it('zone inconnue → 400 avant tout appel à Firebase', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.quartier.count.mockResolvedValue(1); // 1 trouvé sur 2 demandés
      await expect(
        service.createDriver({ ...baseDto, zoneIds: ['q1', 'q2'] }, 'a'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(firebase.createUser).not.toHaveBeenCalled();
    });
  });

  // ─── Activation / désactivation ────────────────────────────────────────────

  describe('activate', () => {
    it('pose isActive, activatedAt et activatedById', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: false });
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        statusUser: 'ACTIVE',
        firebaseUid: 'fb1',
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'LIVREUR' });

      await service.activate('u1', 'admin-9');

      expect(prisma.driverProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isActive: true,
            activatedById: 'admin-9',
          }),
        }),
      );
    });

    /**
     * Un profil « actif » sur un compte suspendu décrirait un livreur que
     * `RolesGuard` rejette à chaque requête — un état qui ne veut rien dire.
     */
    it('compte suspendu → 409, le profil n’est pas activé', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: false });
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        statusUser: 'BLOCKED',
        firebaseUid: 'fb1',
      });
      await expect(service.activate('u1', 'a')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.driverProfile.update).not.toHaveBeenCalled();
    });

    it('déjà actif → 409', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: true });
      await expect(service.activate('u1', 'a')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('compte sans profil → 404 explicite', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue(null);
      await expect(service.activate('u1', 'a')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('deactivate', () => {
    /**
     * Désactiver un livreur en pleine course laisserait une commande sans
     * porteur. L'arbitrage — réassigner ou annuler — appartient au vendeur.
     */
    it('course en cours → 409 nommant la commande', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: true });
      prisma.delivery.findFirst.mockResolvedValue({
        id: 'd1',
        orderId: 'o-42',
        status: 'EN_TRANSIT',
      });
      await expect(service.deactivate('u1', {}, 'a')).rejects.toThrow(/o-42/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    /**
     * La liste d'assignation lit `driverStatus` : un profil désactivé mais
     * resté « AVAILABLE » continuerait d'y figurer jusqu'à ce que le livreur
     * rouvre l'application.
     */
    it('sans course → désactive ET repasse la disponibilité à OFFLINE', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: true });
      prisma.delivery.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'LIVREUR' });
      prisma.$transaction.mockResolvedValue([{}, {}]);

      await service.deactivate('u1', { reason: 'Papiers expirés' }, 'admin-3');

      expect(prisma.driverProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { isActive: false, deactivationReason: 'Papiers expirés' },
        }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { driverStatus: 'OFFLINE' } }),
      );
    });
  });
});
