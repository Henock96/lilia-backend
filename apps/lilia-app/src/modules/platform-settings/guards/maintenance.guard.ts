import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/types/authenticated-request.interface';
import { PlatformSettingsService } from '../platform-settings.service';

/**
 * Bloque la route checkout quand le mode maintenance est actif.
 * L'ADMIN passe outre. Posé uniquement sur POST /orders/checkout.
 *
 * Le rôle est lu sur `request.user`, peuplé par le `RolesGuard` global —
 * qui s'exécute avant ce guard de route, même en l'absence de `@Roles()`.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly settings: PlatformSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { maintenanceMode, maintenanceMessage } = await this.settings.getSettings();
    if (!maintenanceMode) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user?.role === 'ADMIN') return true;

    throw new ServiceUnavailableException(
      maintenanceMessage ||
        'La plateforme est en maintenance. Réessayez dans quelques instants.',
    );
  }
}
