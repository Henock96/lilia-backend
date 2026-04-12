/* eslint-disable prettier/prettier */
// auth/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '@prisma/client';
import { AuthenticatedRequest } from '../types/authenticated-request.interface';

/**
 * Injecte le user Prisma directement dans un paramètre de controller.
 * Nécessite que RolesGuard ait été exécuté en amont.
 *
 * @example
 * @Get('profile')
 * getProfile(@CurrentUser() user: User) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);

