/* eslint-disable prettier/prettier */
import { CanActivate, ExecutionContext,Logger, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserCacheService } from '../services/user-cache.service';
import { AuthenticatedRequest } from '../types/authenticated-request.interface';
import { accessRevocationReason } from '../utils/account-access';
import { ALLOW_UNSYNCED_KEY } from '../decorators/allow-unsynced.decorator';

@Injectable()
export class RolesGuard implements CanActivate{
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private reflector: Reflector,
    private userCache: UserCacheService,
  ) {}

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
     * UserCacheService sert un cache Redis (TTL 5min) avec fallback Prisma.
     */
    if (!request.user) {
      const user = await this.userCache.getByFirebaseUid(request.firebaseUser.uid);

      if (user) {
        request.user = user; // ← disponible dans tous les controllers via @CurrentUser()
      }
    }

    // Compte banni ou supprimé : verrouillage global, quelle que soit la route
    // authentifiée. (Note : à cause du cache user 5 min, un changement de statut
    // peut mettre jusqu'à 5 min à s'appliquer — penser à invalider le cache à la
    // modification du statut.)
    const revoked = accessRevocationReason(request.user?.statusUser);
    if (revoked) {
      this.logger.warn(
        `Accès refusé (${request.user?.statusUser}) : ${request.firebaseUser.uid}`,
      );
      throw new ForbiddenException(revoked);
    }

    // Fix M6 : sans @Roles(), le guard faisait `return true` même quand le
    // user Prisma était absent — @CurrentUser() arrivait alors `undefined` et
    // `PUT /users/me` plantait sur `updateUser(undefined.id)` (500 opaque).
    // On exige donc le user synchronisé partout, sauf sur les routes marquées
    // @AllowUnsynced() (POST /users/sync, GET /users/me).
    if (!request.user) {
      const allowUnsynced = this.reflector.getAllAndOverride<boolean>(
        ALLOW_UNSYNCED_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (allowUnsynced) return true;

      this.logger.warn(`User Firebase introuvable en DB : ${request.firebaseUser.uid}`);
      throw new ForbiddenException(
        'Compte non synchronisé. Appelez POST /users/sync avant cette action.',
      );
    }

    // Pas de @Roles() sur cette route → authentifié suffit, pas de check rôle
    if (!requiredRoles?.length) return true;

    if (!requiredRoles.includes(request.user.role)) {
      this.logger.warn(
        `Accès refusé : ${request.user.role} tente d'accéder à une route réservée à [${requiredRoles.join(', ')}]`,
      );
      throw new ForbiddenException('Accès refusé');
    }

    return true;

  }
}