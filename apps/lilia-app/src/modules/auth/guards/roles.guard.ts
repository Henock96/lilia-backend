/* eslint-disable prettier/prettier */
import { CanActivate, ExecutionContext,Logger, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../../src/prisma/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedRequest } from '../types/authenticated-request.interface';

@Injectable()
export class RolesGuard implements CanActivate{
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private reflector: Reflector, private prisma: PrismaService){}

  async canActivate(context: ExecutionContext): Promise<boolean>{
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Routes @Public() : firebaseUser absent, pas de rôle → on laisse passer
    if (!request.firebaseUser) {
      if (!requiredRoles?.length) return true;
      throw new UnauthorizedException('Guard mal configuré : FirebaseAuthGuard requis avant RolesGuard');
    }

    /**
     * On récupère le user Prisma UNE SEULE FOIS par requête,
     * même sans @Roles(), pour que @CurrentUser() fonctionne partout.
     */
    if (!request.user) {
      const user = await this.prisma.user.findUnique({
        where: { firebaseUid: request.firebaseUser.uid },
      });

      if (user) {
        request.user = user; // ← disponible dans tous les controllers via @CurrentUser()
      }
    }

    // Pas de @Roles() sur cette route → authentifié suffit, pas de check rôle
    if (!requiredRoles?.length) return true;

    if (!request.user) {
      this.logger.warn(`User Firebase introuvable en DB : ${request.firebaseUser.uid}`);
      throw new ForbiddenException('Compte non trouvé');
    }

    if (!requiredRoles.includes(request.user.role)) {
      this.logger.warn(
        `Accès refusé : ${request.user.role} tente d'accéder à une route réservée à [${requiredRoles.join(', ')}]`,
      );
      throw new ForbiddenException('Accès refusé');
    }

    return true;

  }
}