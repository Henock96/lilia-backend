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
      updateMany: jest.fn(),
    },
    driverProfile: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    delivery: { findFirst: jest.fn(), findMany: jest.fn() },
    deliveryReview: { aggregate: jest.fn() },
    quartier: { count: jest.fn() },
    // F3-12.0 — `lockDriverRow` : `SELECT … FROM "User" … FOR UPDATE`.
    $queryRaw: jest.fn(),
    // F3-12.1 — révocation des offres (R3 avant R4, balayage après commit).
    $executeRaw: jest.fn().mockResolvedValue(0),
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

    it('fige l’économie du livreur à la création, avec les défauts', async () => {
      // `LILIA` / `PER_DELIVERY` / taux plateforme : ce sont les défauts du
      // schéma, mais l'écriture doit être explicite dès qu'un admin les choisit.
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'u-new', role: 'LIVREUR', driverProfile: {} });

      await service.createDriver(
        {
          ...baseDto,
          employmentType: 'INDEPENDENT' as never,
          driverSharePercent: 70,
        },
        'admin-1',
      );

      expect(prisma.driverProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            employmentType: 'INDEPENDENT',
            driverSharePercent: 70,
          }),
        }),
      );
    });

    it('sans précision, l’économie n’est PAS écrite — les défauts du schéma valent', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'u-new', role: 'LIVREUR', driverProfile: {} });

      await service.createDriver(baseDto, 'admin-1');

      const data = prisma.driverProfile.create.mock.calls[0][0].data;
      expect(data.employmentType).toBeUndefined();
      expect(data.driverSharePercent).toBeUndefined();
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
    /** F3-12.1 R7 — le compte se lit sous le verrou du livreur (R4). */
    const lockedAccount = (statusUser = 'ACTIVE', banPendingAt = null) =>
      prisma.$queryRaw.mockResolvedValue([
        { role: 'LIVREUR', statusUser, driverStatus: 'OFFLINE', banPendingAt },
      ]);

    it('pose isActive, activatedAt et activatedById', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: false });
      lockedAccount();
      prisma.driverProfile.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'LIVREUR' });

      await service.activate('u1', 'admin-9');

      expect(prisma.driverProfile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1', isActive: false },
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
      lockedAccount('BLOCKED');
      await expect(service.activate('u1', 'a')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.driverProfile.updateMany).not.toHaveBeenCalled();
    });

    it('ban programmé → 409, le profil n’est pas activé', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: false });
      lockedAccount('ACTIVE', new Date() as never);
      await expect(service.activate('u1', 'a')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.driverProfile.updateMany).not.toHaveBeenCalled();
    });

    it('activé par un autre administrateur pendant l’attente → 409', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: false });
      lockedAccount();
      prisma.driverProfile.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.activate('u1', 'a')).rejects.toBeInstanceOf(
        ConflictException,
      );
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
    const lockedDriver = (driverStatus = 'AVAILABLE') =>
      prisma.$queryRaw.mockResolvedValue([
        { role: 'LIVREUR', statusUser: 'ACTIVE', driverStatus },
      ]);

    it('course en cours → 409 nommant la commande', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: true });
      lockedDriver('ON_DELIVERY');
      prisma.delivery.findFirst.mockResolvedValue({
        id: 'd1',
        orderId: 'o-42',
        status: 'EN_TRANSIT',
      });
      await expect(service.deactivate('u1', {}, 'a')).rejects.toThrow(/o-42/);
      // F3-12.0 — le contrôle vit désormais DANS la transaction, sous le
      // verrou du livreur ; ce qui compte est que rien ne soit écrit.
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(prisma.driverProfile.updateMany).not.toHaveBeenCalled();
      expect(prisma.driverProfile.update).not.toHaveBeenCalled();
    });

    /**
     * F3-12.0 — la course est cherchée APRÈS le verrou du livreur : une
     * acceptation commise pendant l'attente est vue, pas manquée.
     */
    it('F3-12.0 — la course est lue sous le verrou du livreur, dans la transaction', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: true });
      lockedDriver();
      prisma.delivery.findFirst.mockResolvedValue(null);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.driverProfile.updateMany.mockResolvedValue({ count: 1 });

      await service.deactivate('u1', {}, 'a');

      const lock = prisma.$queryRaw.mock.invocationCallOrder[0];
      expect(lock).toBeLessThan(
        prisma.delivery.findFirst.mock.invocationCallOrder[0],
      );
      // R4 (User) avant R5 (DriverProfile) : l'ordre inverse s'interbloquait.
      expect(prisma.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.driverProfile.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('F3-12.0 — désactivé par un autre administrateur pendant l’attente → 409, rien d’écrit', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: true });
      lockedDriver();
      prisma.delivery.findFirst.mockResolvedValue(null);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      // Le profil n'est plus actif quand on le revendique.
      prisma.driverProfile.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.deactivate('u1', {}, 'a')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    /**
     * La liste d'assignation lit `driverStatus` : un profil désactivé mais
     * resté « AVAILABLE » continuerait d'y figurer jusqu'à ce que le livreur
     * rouvre l'application.
     */
    it('sans course → désactive ET repasse la disponibilité à OFFLINE', async () => {
      prisma.driverProfile.findUnique.mockResolvedValue({ isActive: true });
      lockedDriver();
      prisma.delivery.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'LIVREUR' });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.driverProfile.updateMany.mockResolvedValue({ count: 1 });

      await service.deactivate('u1', { reason: 'Papiers expirés' }, 'admin-3');

      // Revendiqués (CAS) et non plus écrits sans condition — F3-12.0.
      expect(prisma.driverProfile.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', isActive: true },
        data: { isActive: false, deactivationReason: 'Papiers expirés' },
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1', driverStatus: 'AVAILABLE' },
        data: { driverStatus: 'OFFLINE' },
      });
    });
  });
});
