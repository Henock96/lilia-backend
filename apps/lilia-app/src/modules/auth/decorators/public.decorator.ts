/* eslint-disable prettier/prettier */
// auth/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marque une route comme publique — FirebaseAuthGuard la court-circuite.
 *
 * @example
 * @Public()
 * @Get('health')
 * health() { return 'ok'; }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
