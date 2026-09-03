import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';

import { AdminUsersService } from './admin-users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserCacheService } from '../auth/services/user-cache.service';

/**
 * Garde-fous de cohérence sur le changement de rôle.
 *
 * Un `UPDATE User SET role` est une écriture d'une ligne ; ses conséquences,
 * elles, portent sur des relations que rien ne surveillait. Retirer le rôle
 * RESTAURATEUR au propriétaire d'une boutique laissait `Restaurant.ownerId`
 * pointer sur lui **tout en le faisant rejeter par `@Roles('RESTAURATEUR')`** :
 * la boutique restait `ACTIVATED` et visible des clients, sans plus personne
 * pour la gérer ni la fermer.
 *
 * Ces refus vivent dans le service, donc ils valent aussi pour un appel direct
 * à l'API — pas seulement pour l'écran d'administration.
 */
describe('AdminUsersService — cohérence des changements de rôle', () => {
  let service: AdminUsersService;

  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    driverProfile: { update: jest.fn() },
    delivery: { findFirst: jest.fn() },
    $transaction: jest.fn((cb: any) => cb(prisma)),
  };
  const userCache = { invalidateOrThrow: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma));
    prisma.delivery.findFirst.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({ id: 'u1', role: 'CLIENT' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: UserCacheService, useValue: userCache },
      ],
    }).compile();
    service = module.get(AdminUsersService);
  });

  const user = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    firebaseUid: 'fb1',
    role: 'CLIENT',
    restaurant: null,
    driverProfile: null,
    ...over,
  });

  it('rétrograder un ADMIN → refusé (règle historique)', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ role: 'ADMIN' }));
    await expect(
      service.updateUserRole('u1', { role: 'CLIENT' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rôle identique → refusé (évite une écriture et une entrée d’audit vides)', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ role: 'LIVREUR' }));
    await expect(
      service.updateUserRole('u1', { role: 'LIVREUR' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('RESTAURATEUR propriétaire d’une boutique → refusé, en la nommant', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({ role: 'RESTAURATEUR', restaurant: { id: 'r1', nom: 'Chez Awa' } }),
    );
    await expect(
      service.updateUserRole('u1', { role: 'CLIENT' } as never),
    ).rejects.toThrow(/Chez Awa/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('RESTAURATEUR sans boutique → autorisé', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ role: 'RESTAURATEUR' }));
    await expect(
      service.updateUserRole('u1', { role: 'CLIENT' } as never),
    ).resolves.toBeDefined();
  });

  it('LIVREUR avec une course en cours → refusé, en nommant la commande', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ role: 'LIVREUR' }));
    prisma.delivery.findFirst.mockResolvedValue({
      orderId: 'o-42',
      status: 'EN_TRANSIT',
    });
    await expect(
      service.updateUserRole('u1', { role: 'CLIENT' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  /**
   * Quitter le rôle LIVREUR doit aussi sortir le compte de la file
   * d'assignation : un profil resté actif y ferait apparaître quelqu'un qui
   * n'est plus livreur. Le profil lui-même est **conservé** — si l'admin s'est
   * trompé, le remettre LIVREUR ne lui fait pas ressaisir plaque et permis.
   */
  it('LIVREUR → CLIENT : profil désactivé et disponibilité effacée, profil conservé', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({ role: 'LIVREUR', driverProfile: { id: 'p1', isActive: true } }),
    );

    await service.updateUserRole('u1', { role: 'CLIENT' } as never);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { driverStatus: null } }),
    );
    expect(prisma.driverProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false }),
      }),
    );
  });

  it('CLIENT → LIVREUR : aucun profil touché (il n’en a pas encore)', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ role: 'CLIENT' }));
    await service.updateUserRole('u1', { role: 'LIVREUR' } as never);
    expect(prisma.driverProfile.update).not.toHaveBeenCalled();
  });

  it('le cache user est invalidé — le rôle est lu par RolesGuard à chaque requête', async () => {
    prisma.user.findUnique.mockResolvedValue(user());
    await service.updateUserRole('u1', { role: 'LIVREUR' } as never);
    expect(userCache.invalidateOrThrow).toHaveBeenCalledWith('fb1');
  });
});
