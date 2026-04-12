/* eslint-disable prettier/prettier */
// auth/decorators/firebase-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { DecodedIdToken } from 'firebase-admin/auth';
import { AuthenticatedRequest } from '../types/authenticated-request.interface';

/**
 * Injecte le token Firebase décodé dans un paramètre de controller.
 * Disponible dès que FirebaseAuthGuard est passé (sans RolesGuard requis).
 *
 * @example
 * @Post('sync')
 * sync(@FirebaseUser() fbUser: DecodedIdToken) { ... }
 */
export const FirebaseUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DecodedIdToken => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.firebaseUser;
  },
);

