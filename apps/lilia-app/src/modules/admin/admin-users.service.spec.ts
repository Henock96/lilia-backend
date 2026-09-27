import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { StatusUser } from '@prisma/client';

import { AdminUsersService } from './admin-users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserCacheService } from '../auth/services/user-cache.service';

/**
 * Le bannissement était un no-op : la méthode loguait et invalidait le cache
 * sans jamais écrire `statusUser`. Ces tests verrouillent l'écriture en base,
 * qui est la seule chose que lisent `RolesGuard` et `TrackingGateway`.
 *
 * F3-12.1 R7 — la décision se prend sous le verrou du compte (R4), après le
 * retrait des offres (R3) ; un livreur en pleine course voit son ban
 * DIFFÉRÉ. La concurrence réelle est prouvée par
 * `test/integration/driver-account-gates.int-spec.ts`.
 */
describe('AdminUsersService — bannissement', () => {
  let service: AdminUsersService;
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    delivery: { findFirst: jest.fn(), count: jest.fn() },
    driverProfile: { updateMany: jest.fn() },
    incident: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn((cb: any) => cb(prisma)),
  };
  const userCache = { invalidateOrThrow: jest.fn() };

  const client = {
    id: 'user-1',
    firebaseUid: 'fb-1',
    role: 'CLIENT',
    statusUser: StatusUser.ACTIVE,
  };
  const locked = (over: Record<string, unknown> = {}) =>
    prisma.$queryRaw.mockResolvedValue([
      {
        role: 'CLIENT',
        statusUser: 'ACTIVE',
        driverStatus: null,
        banPendingAt: null,
        ...over,
      },
    ]);

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma));
    prisma.$executeRaw.mockResolvedValue(0);
    prisma.delivery.findFirst.mockResolvedValue(null);
    prisma.delivery.count.mockResolvedValue(0);
    prisma.incident.findFirst.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({});
    userCache.invalidateOrThrow.mockResolvedValue(undefined);
    locked();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: UserCacheService, useValue: userCache },
      ],
    }).compile();

    service = module.get(AdminUsersService);
  });

  it('écrit statusUser=BLOCKED en base', async () => {
    prisma.user.findUnique.mockResolvedValue(client);

    const result = await service.banUser('user-1', 'fraude');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { statusUser: StatusUser.BLOCKED },
    });
    expect(userCache.invalidateOrThrow).toHaveBeenCalledWith('fb-1');
    expect(result).toEqual({
      firebaseUid: 'fb-1',
      userId: 'user-1',
      cacheInvalidated: true,
      mode: 'immediate',
      waitingAssignments: 0,
    });
  });

  it('livreur sans course : BLOCKED + OFFLINE, offres retirées avant le verrou', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...client, role: 'LIVREUR' });
    locked({ role: 'LIVREUR', driverStatus: 'AVAILABLE' });

    await service.banUser('user-1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { statusUser: StatusUser.BLOCKED, driverStatus: 'OFFLINE' },
    });
    const [cancel, sweep] = prisma.$executeRaw.mock.invocationCallOrder;
    expect(cancel).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(sweep).toBeGreaterThan(
      prisma.user.update.mock.invocationCallOrder[0],
    );
  });

  it('livreur en pleine course : ban différé, compte laissé ACTIVE, incident ouvert', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...client, role: 'LIVREUR' });
    locked({ role: 'LIVREUR', driverStatus: 'ON_DELIVERY' });
    prisma.delivery.findFirst.mockResolvedValue({
      orderId: 'o-1',
      status: 'EN_TRANSIT',
    });

    const result = await service.banUser('user-1', 'fraude', 'admin-1');

    expect(result.mode).toBe('deferred');
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.statusUser).toBeUndefined();
    expect(data.banPendingAt).toBeInstanceOf(Date);
    expect(data.banPendingById).toBe('admin-1');
    expect(prisma.incident.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'o-1',
          riderId: 'user-1',
          dedupKey: 'ban_pending:user-1',
        }),
      }),
    );
  });

  it('ban déjà programmé → 409', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...client, role: 'LIVREUR' });
    locked({ role: 'LIVREUR', banPendingAt: new Date() });
    prisma.delivery.findFirst.mockResolvedValue({
      orderId: 'o-1',
      status: 'ACCEPTER',
    });
    await expect(service.banUser('user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('déjà banni → 409, rien écrit', async () => {
    prisma.user.findUnique.mockResolvedValue(client);
    locked({ statusUser: 'BLOCKED' });
    await expect(service.banUser('user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuse de bannir un ADMIN et ne touche pas la base', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...client, role: 'ADMIN' });

    await expect(service.banUser('user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('lève 404 sur un utilisateur inconnu', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.banUser('nope')).rejects.toThrow(NotFoundException);
  });

  it('signale cacheInvalidated=false si Redis est indisponible', async () => {
    prisma.user.findUnique.mockResolvedValue(client);
    userCache.invalidateOrThrow.mockRejectedValue(new Error('Redis down'));

    const result = await service.banUser('user-1');

    // Le ban est bien appliqué en base — seule la propagation est retardée.
    expect(prisma.user.update).toHaveBeenCalled();
    expect(result.cacheInvalidated).toBe(false);
  });

  it('unbanUser repasse le statut à ACTIVE', async () => {
    prisma.user.findUnique.mockResolvedValue(client);
    locked({ statusUser: 'BLOCKED' });

    const result = await service.unbanUser('user-1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { statusUser: StatusUser.ACTIVE },
    });
    expect(result.wasBlocked).toBe(true);
  });

  it('unbanUser d’un livreur : OFFLINE et capacité d’offres retirée', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...client, role: 'LIVREUR' });
    locked({ role: 'LIVREUR', statusUser: 'BLOCKED', driverStatus: 'OFFLINE' });

    await service.unbanUser('user-1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { statusUser: StatusUser.ACTIVE, driverStatus: 'OFFLINE' },
    });
    expect(prisma.driverProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { offersEnabledAt: null },
    });
  });

  it('unbanUser d’un ban programmé : drapeau effacé, Firebase non concerné', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...client, role: 'LIVREUR' });
    locked({ role: 'LIVREUR', banPendingAt: new Date() });

    const result = await service.unbanUser('user-1');

    expect(result.wasBlocked).toBe(false);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({
      banPendingAt: null,
      banPendingReason: null,
      banPendingById: null,
    });
  });

  it('unbanUser refuse un utilisateur non banni', async () => {
    prisma.user.findUnique.mockResolvedValue(client);

    await expect(service.unbanUser('user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
