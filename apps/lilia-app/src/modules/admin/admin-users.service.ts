import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
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
    await this.userCache.invalidate(user.firebaseUid);

    this.logger.warn(`Rôle modifié : user ${userId} → ${dto.role}`);
    return { data: updated, message: `Rôle mis à jour : ${dto.role}` };
  }

  /**
   * Bannit un utilisateur : désactive son compte et révoque ses tokens.
   * À coupler avec FirebaseService.revokeUserTokens() dans le controller.
   */
  async banUser(userId: string, reason?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    if (user.role === 'ADMIN')
      throw new BadRequestException('Impossible de bannir un ADMIN.');

    // On stocke la raison dans les métadonnées — à adapter si tu ajoutes un champ bannedAt
    this.logger.warn(
      `User ${userId} banni — raison : ${reason ?? 'non précisée'}`,
    );

    // Invalider le cache : la prochaine requête forcera un refetch et verra
    // statusUser=BANNED (à venir) ou refusera l'accès.
    await this.userCache.invalidate(user.firebaseUid);

    // Retourne le firebaseUid pour que le controller révoque les tokens Firebase
    return { firebaseUid: user.firebaseUid, userId: user.id };
  }
}
