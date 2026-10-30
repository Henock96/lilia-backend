import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { canAccessShop } from './shop-access';

/** Rôles qu'un propriétaire (ou un admin) peut confier. OWNER ne se donne pas. */
export const INVITABLE_SHOP_ROLES = ['MANAGER', 'STAFF'] as const;
export type InvitableShopRole = (typeof INVITABLE_SHOP_ROLES)[number];

/**
 * Membres d'une boutique (durcissement lot 3, point 7).
 *
 * - **Identité propre** : on ajoute un compte EXISTANT, désigné par son
 *   e-mail ; jamais un compte partagé. Sa MFA est la sienne.
 * - **Rôle de compte** : il doit déjà être `RESTAURATEUR` (les routes vendeur
 *   l'exigent). Le changer est un geste d'administrateur (`USER_ROLES`) : ce
 *   service ne le fait pas en douce.
 * - **Révocation** : immédiate — les droits sont relus en base à chaque
 *   requête (`shop-access.ts`), aucun cache à purger. La ligne reste, avec qui,
 *   quand, pourquoi.
 * - **Qui gère** : un ADMIN, ou un membre portant `MEMBERS` (le propriétaire).
 */
@Injectable()
export class ShopMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertCanManage(
    actor: { id: string; role: string },
    restaurantId: string,
  ): Promise<void> {
    const shop = await this.prisma.restaurant.count({
      where: { id: restaurantId },
    });
    if (!shop) throw new NotFoundException('Boutique introuvable.');
    if (actor.role === 'ADMIN') return;
    if (
      !(await canAccessShop(this.prisma, actor.id, restaurantId, 'MEMBERS'))
    ) {
      throw new ForbiddenException(
        'Seul le propriétaire de la boutique gère ses membres.',
      );
    }
  }

  async list(actor: { id: string; role: string }, restaurantId: string) {
    await this.assertCanManage(actor, restaurantId);
    return this.prisma.shopMembership.findMany({
      where: { restaurantId },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        role: true,
        status: true,
        createdAt: true,
        activatedAt: true,
        revokedAt: true,
        revokeReason: true,
        user: { select: { id: true, nom: true, email: true } },
      },
    });
  }

  async add(
    actor: { id: string; role: string },
    restaurantId: string,
    input: { email: string; role: InvitableShopRole },
  ) {
    await this.assertCanManage(actor, restaurantId);
    if (!INVITABLE_SHOP_ROLES.includes(input.role)) {
      throw new BadRequestException('Rôle inconnu : MANAGER ou STAFF.');
    }
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: input.email.trim(), mode: 'insensitive' } },
      select: { id: true, role: true, statusUser: true },
    });
    if (!user) {
      throw new NotFoundException(
        'Aucun compte avec cet e-mail : la personne doit d’abord créer le sien (son identité, sa double authentification).',
      );
    }
    if (user.role !== 'RESTAURATEUR' || user.statusUser !== 'ACTIVE') {
      throw new ConflictException({
        message:
          'Ce compte n’est pas un compte vendeur actif. Un administrateur doit d’abord lui attribuer le rôle vendeur.',
        code: 'MEMBER_ROLE_REQUIRED',
      });
    }
    try {
      return await this.prisma.shopMembership.create({
        data: {
          userId: user.id,
          restaurantId,
          role: input.role,
          status: 'ACTIVE',
          invitedBy: actor.id,
          activatedAt: new Date(),
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ce compte est déjà membre de la boutique.',
        );
      }
      throw err;
    }
  }

  async revoke(
    actor: { id: string; role: string },
    restaurantId: string,
    membershipId: string,
    reason: string,
  ) {
    await this.assertCanManage(actor, restaurantId);
    const membership = await this.prisma.shopMembership.findFirst({
      where: { id: membershipId, restaurantId },
      select: { id: true, role: true, status: true },
    });
    if (!membership) throw new NotFoundException('Membre introuvable.');
    if (membership.role === 'OWNER') {
      // Le propriétaire se change par un transfert de boutique, geste
      // d'administration distinct — pas par une révocation.
      throw new ConflictException(
        'Le propriétaire ne se révoque pas : un transfert de boutique se fait avec un administrateur.',
      );
    }
    const res = await this.prisma.shopMembership.updateMany({
      where: { id: membershipId, status: { not: 'REVOKED' } },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedBy: actor.id,
        revokeReason: reason.trim(),
      },
    });
    if (res.count === 0) {
      throw new ConflictException('Ce membre est déjà révoqué.');
    }
    return this.prisma.shopMembership.findUniqueOrThrow({
      where: { id: membershipId },
    });
  }
}
