import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AdminCapability, User } from '@prisma/client';

import { FirebaseService } from '../../firebase/firebase.service';
import { REQUIRE_CAPABILITY_KEY } from '../decorators/require-capability.decorator';
import { AuthenticatedRequest } from '../types/authenticated-request.interface';

/** Âge maximal de la dernière authentification pour un geste FINANCE_* (R-08.2). */
export const FINANCE_STEP_UP_MINUTES = 15;

const MFA_CAPABILITIES: readonly AdminCapability[] = [
  AdminCapability.FINANCE_EXECUTE,
  AdminCapability.FINANCE_APPROVE,
  AdminCapability.USER_ROLES,
  AdminCapability.SETTINGS,
];

/**
 * F3-08 — qu'un compte ADMIN volé ne suffise pas à sortir de l'argent.
 *
 * Après `RolesGuard` (qui a chargé `request.user`), sur les seules routes
 * marquées `@RequireCapability` :
 *
 *  1. **capacité** : l'administrateur doit la porter (403 `CAPABILITY_REQUIRED`) ;
 *  2. **MFA** — seulement si `ADMIN_MFA_REQUIRED=true`, à allumer une fois
 *     TOTP activé dans Firebase et les admins enrôlés :
 *     - second facteur présent dans le jeton (403 `MFA_REQUIRED`) ;
 *     - pour `FINANCE_*`, authentification de moins de 15 min
 *       (401 `MFA_STEP_UP_REQUIRED`) et jeton non révoqué (R-08.3 :
 *       `checkRevoked`, un appel Firebase — sur ces routes seulement).
 */
@Injectable()
export class AdminSecurityGuard implements CanActivate {
  private readonly logger = new Logger(AdminSecurityGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly firebase: FirebaseService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const capability = this.reflector.getAllAndOverride<AdminCapability>(
      REQUIRE_CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!capability) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user as User | undefined;
    if (user?.role !== 'ADMIN') return true; // RolesGuard a déjà tranché

    if (!(user.adminCapabilities ?? []).includes(capability)) {
      this.logger.warn(
        `Capacité ${capability} refusée à l'administrateur ${user.id}`,
      );
      throw new ForbiddenException({
        message:
          'Votre compte administrateur n’a pas la capacité requise pour ce geste.',
        code: 'CAPABILITY_REQUIRED',
        capability,
      });
    }

    if (!this.mfaRequired() || !MFA_CAPABILITIES.includes(capability)) {
      return true;
    }
    const token = request.firebaseUser as
      | { firebase?: { sign_in_second_factor?: string }; auth_time?: number }
      | undefined;
    if (!token?.firebase?.sign_in_second_factor) {
      throw new ForbiddenException({
        message:
          'Ce geste exige la double authentification. Activez-la sur votre compte administrateur.',
        code: 'MFA_REQUIRED',
      });
    }
    if (capability.startsWith('FINANCE_')) {
      const ageMinutes = (Date.now() / 1000 - (token.auth_time ?? 0)) / 60;
      if (ageMinutes > FINANCE_STEP_UP_MINUTES) {
        throw new UnauthorizedException({
          message: 'Confirmez votre identité avec votre code pour ce geste.',
          code: 'MFA_STEP_UP_REQUIRED',
        });
      }
      const raw = request.headers.authorization?.split(' ')[1];
      try {
        await this.firebase.getAuth().verifyIdToken(raw ?? '', true);
      } catch {
        throw new UnauthorizedException('TOKEN_REVOKED');
      }
    }
    return true;
  }

  private mfaRequired(): boolean {
    const raw = this.config?.get<string | boolean>('ADMIN_MFA_REQUIRED');
    return raw === true || raw === 'true';
  }
}
