/* eslint-disable prettier/prettier */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Observable } from 'rxjs';
import { AuthenticatedRequest } from '../../modules/auth/types/authenticated-request.interface';

/**
 * Attache l'utilisateur courant au scope Sentry de la requête.
 *
 * Sentry (SDK NestJS) crée un scope isolé par requête : appeler
 * `Sentry.setUser()` ici associe les erreurs de cette requête à l'utilisateur.
 *
 * L'intercepteur s'exécute APRÈS les guards → `request.user` est déjà peuplé
 * par RolesGuard pour les routes authentifiées. Routes publiques : pas de user.
 */
@Injectable()
export class SentryUserInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    const user = request?.user;
    if (user) {
      Sentry.setUser({
        id: user.id,
        email: user.email,
        role: user.role,
      });
    } else if (request?.firebaseUser) {
      // Authentifié Firebase mais pas encore synchronisé en DB
      Sentry.setUser({ id: request.firebaseUser.uid });
    }

    return next.handle();
  }
}
