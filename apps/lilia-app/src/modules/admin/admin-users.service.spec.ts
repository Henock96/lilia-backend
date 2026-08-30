import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StatusUser } from '@prisma/client';

import { AdminUsersService } from './admin-users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserCacheService } from '../auth/services/user-cache.service';

/**
 * Le bannissement était un no-op : la méthode loguait et invalidait le cache
 * sans jamais écrire `statusUser`. Ces tests verrouillent l'écriture en base,
 * qui est la seule chose que lisent `RolesGuard` et `TrackingGateway`.
 */
describe('AdminUsersService — bannissement', () => {
  let service: AdminUsersService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
  };
  let userCache: { invalidateOrThrow: jest.Mock };

  const client = {
    id: 'user-1',
    firebaseUid: 'fb-1',
    role: 'CLIENT',
    statusUser: StatusUser.ACTIVE,
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
    };
    userCache = { invalidateOrThrow: jest.fn().mockResolvedValue(undefined) };

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
    prisma.user.update.mockResolvedValue({});

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
    });
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
    prisma.user.update.mockResolvedValue({});
    userCache.invalidateOrThrow.mockRejectedValue(new Error('Redis down'));

    const result = await service.banUser('user-1');

    // Le ban est bien appliqué en base — seule la propagation est retardée.
    expect(prisma.user.update).toHaveBeenCalled();
    expect(result.cacheInvalidated).toBe(false);
  });

  it('unbanUser repasse le statut à ACTIVE', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...client,
      statusUser: StatusUser.BLOCKED,
    });
    prisma.user.update.mockResolvedValue({});

    await service.unbanUser('user-1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { statusUser: StatusUser.ACTIVE },
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
