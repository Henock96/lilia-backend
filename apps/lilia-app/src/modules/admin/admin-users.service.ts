import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DeliveryStatus, Prisma, Role, StatusUser } from '@prisma/client';
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

  /**
   * Liste des comptes, filtrable par rôle, statut et recherche libre.
   *
   * Les filtres `statusUser` et `search` ont été ajoutés en septembre 2026 en
   * même temps que l'écran d'administration qui les consomme : jusque-là,
   * `GET /admin/users` existait mais n'avait aucun appelant, et personne ne
   * pouvait retrouver un compte autrement qu'en paginant.
   */
  async getAllUsers(
    page = 1,
    limit = 20,
    role?: Role,
    statusUser?: StatusUser,
    search?: string,
  ) {
    const where: Prisma.UserWhereInput = {
      ...(role && { role }),
      ...(statusUser && { statusUser }),
      ...(search && {
        OR: [
          { nom: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search } },
        ],
      }),
    };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
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
   * Fiche d'un compte, avec ce qui le rattache au métier.
   *
   * `restaurant` et `driverProfile` y figurent parce qu'ils conditionnent ce
   * qu'un administrateur a le droit de faire ensuite : on ne retire pas le rôle
   * RESTAURATEUR à quelqu'un qui tient une boutique en ligne sans le savoir.
   */
  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        nom: true,
        phone: true,
        imageUrl: true,
        role: true,
        statusUser: true,
        driverStatus: true,
        createdAt: true,
        lastLogin: true,
        restaurant: {
          select: {
            id: true,
            nom: true,
            onboardingStatus: true,
            adminApproved: true,
            isActive: true,
          },
        },
        driverProfile: {
          select: { id: true, isActive: true, vehicleType: true },
        },
        _count: { select: { orders: true, deliveries: true } },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');
    return { data: user };
  }

  /**
   * Change le rôle d'un utilisateur.
   *
   * Trois refus, et chacun décrit une relation métier qu'un simple `UPDATE`
   * romprait **en silence** :
   *
   * 1. rétrogradation d'un ADMIN — règle historique ;
   * 2. retrait du rôle RESTAURATEUR à un propriétaire de boutique.
   *    `Restaurant.ownerId` resterait sur lui, mais `@Roles('RESTAURATEUR')`
   *    le rejetterait : la boutique deviendrait inadministrable tout en restant
   *    `ACTIVATED` et visible des clients. Personne ne pourrait plus la fermer
   *    ni la corriger — sauf à repasser par cette même route, ce que rien
   *    n'indiquerait ;
   * 3. retrait du rôle LIVREUR à quelqu'un qui a une course en cours, ce qui
   *    laisserait une commande sans porteur.
   *
   * Ces refus ne sont pas un garde-fou d'interface : ils vivent ici, donc ils
   * valent aussi pour un appel direct à l'API.
   */
  async updateUserRole(userId: string, dto: UpdateUserRoleDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        restaurant: { select: { id: true, nom: true } },
        driverProfile: { select: { id: true, isActive: true } },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    if (user.role === dto.role) {
      throw new BadRequestException(`Ce compte est déjà ${dto.role}.`);
    }

    if (user.role === 'ADMIN' && dto.role !== 'ADMIN') {
      throw new BadRequestException(
        "Impossible de rétrograder un compte ADMIN via l'API.",
      );
    }

    if (user.role === Role.RESTAURATEUR && user.restaurant) {
      throw new ConflictException(
        `Ce compte est propriétaire de « ${user.restaurant.nom} ». ` +
          'Transférez ou fermez la boutique avant de changer son rôle — sinon ' +
          'elle resterait en ligne sans personne pour la gérer.',
      );
    }

    if (user.role === Role.LIVREUR) {
      const activeMission = await this.prisma.delivery.findFirst({
        where: {
          delivererId: userId,
          status: {
            in: [
              DeliveryStatus.ASSIGNER,
              DeliveryStatus.ACCEPTER,
              DeliveryStatus.EN_TRANSIT,
            ],
          },
        },
        select: { orderId: true, status: true },
      });
      if (activeMission) {
        throw new ConflictException(
          `Ce livreur a une course en cours (${activeMission.status}, commande ` +
            `${activeMission.orderId}). Réassignez-la avant de changer son rôle.`,
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Quitter le rôle LIVREUR retire aussi la disponibilité et met le profil
      // hors service : le laisser « actif » ferait apparaître dans les
      // requêtes d'assignation un profil dont le compte n'est plus livreur.
      // Le profil lui-même est conservé — si l'admin s'est trompé, le
      // remettre LIVREUR ne lui fait pas ressaisir plaque et permis.
      if (user.role === Role.LIVREUR && dto.role !== Role.LIVREUR) {
        await tx.user.update({
          where: { id: userId },
          data: { driverStatus: null },
        });
        if (user.driverProfile) {
          await tx.driverProfile.update({
            where: { userId },
            data: {
              isActive: false,
              deactivationReason: `Rôle changé en ${dto.role}`,
            },
          });
        }
      }

      return tx.user.update({
        where: { id: userId },
        data: { role: dto.role },
        select: { id: true, email: true, nom: true, role: true },
      });
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
