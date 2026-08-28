import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role, StatusUser } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UserCacheService } from '../auth/services/user-cache.service';

/**
 * Gestion des utilisateurs côté admin (LIL-134) : liste tous rôles, changement
 * de rôle (avec invalidation du cache lu par RolesGuard) et bannissement.
 * Extrait de `AdminService` — API publique inchangée.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private prisma: PrismaService,
    private userCache: UserCacheService,
  ) {}

  async getAllUsers(page = 1, limit = 20, role?: Role) {
    const where = role ? { role } : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          role: true,
          statusUser: true,
          createdAt: true,
          lastLogin: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: users, total, page, limit };
  }

  /**
   * Change le rôle d'un utilisateur.
   * Protège contre la rétrogradation d'un ADMIN.
   */
  async updateUserRole(userId: string, dto: UpdateUserRoleDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    if (user.role === 'ADMIN' && dto.role !== 'ADMIN') {
      throw new BadRequestException(
        "Impossible de rétrograder un compte ADMIN via l'API.",
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
      select: { id: true, email: true, nom: true, role: true },
    });

    // Invalider le cache : le role est lu par RolesGuard à chaque requête.
    await this.invalidateCache(user.firebaseUid);

    this.logger.warn(`Rôle modifié : user ${userId} → ${dto.role}`);
    return { data: updated, message: `Rôle mis à jour : ${dto.role}` };
  }

  /**
   * Bannit un utilisateur : passe `statusUser` à BLOCKED en base — c'est ce que
   * lit `RolesGuard` sur chaque route authentifiée et `TrackingGateway` sur
   * chaque message WebSocket.
   *
   * Le controller complète avec `FirebaseService.setUserDisabled(uid, true)` et
   * `revokeUserTokens(uid)` : sans la désactivation du compte Firebase, un banni
   * se reconnecte simplement et obtient un token frais.
   */
  async banUser(userId: string, reason?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    if (user.role === 'ADMIN')
      throw new BadRequestException('Impossible de bannir un ADMIN.');

    await this.prisma.user.update({
      where: { id: userId },
      data: { statusUser: StatusUser.BLOCKED },
    });

    // Invalider le cache : le statut est lu par RolesGuard à chaque requête et
    // le TTL Redis est de 5 min — sans invalidation le ban traînerait d'autant.
    const cacheInvalidated = await this.invalidateCache(user.firebaseUid);

    this.logger.warn(
      `User ${userId} banni — raison : ${reason ?? 'non précisée'}`,
    );

    // Retourne le firebaseUid pour que le controller agisse côté Firebase Auth
    return { firebaseUid: user.firebaseUid, userId: user.id, cacheInvalidated };
  }

  /**
   * Lève le bannissement : `statusUser` repasse à ACTIVE. Le controller
   * réactive le compte Firebase en parallèle.
   */
  async unbanUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    if (user.statusUser !== StatusUser.BLOCKED) {
      throw new BadRequestException("Cet utilisateur n'est pas banni.");
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { statusUser: StatusUser.ACTIVE },
    });

    const cacheInvalidated = await this.invalidateCache(user.firebaseUid);

    this.logger.warn(`User ${userId} débanni`);
    return { firebaseUid: user.firebaseUid, userId: user.id, cacheInvalidated };
  }

  /**
   * Purge le cache user et **remonte l'échec** au lieu de l'avaler.
   *
   * Le ban est déjà écrit en base à ce stade : on ne veut pas faire échouer la
   * requête (ce serait un faux négatif pour l'admin), mais on veut qu'il sache
   * que l'application peut traîner jusqu'à 5 min si Redis est en vrac.
   */
  private async invalidateCache(firebaseUid: string): Promise<boolean> {
    try {
      await this.userCache.invalidateOrThrow(firebaseUid);
      return true;
    } catch (err) {
      this.logger.error(
        `Cache user non invalidé pour ${firebaseUid} — le changement de statut ` +
          `mettra jusqu'à 5 min à s'appliquer : ${(err as Error).message}`,
      );
      return false;
    }
  }
}
