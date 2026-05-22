import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DecodedIdToken } from 'firebase-admin/auth';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings.service';

/**
 * Bloque la route checkout quand le mode maintenance est actif.
 * L'ADMIN passe outre. Posé uniquement sur POST /orders/checkout.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const settings = await this.settings.getSettings();
    if (!settings.maintenanceMode) return true;

    const request = context.switchToHttp().getRequest<{ firebaseUser?: DecodedIdToken }>();
    const firebaseUid = request.firebaseUser?.uid;
    const user = firebaseUid
      ? await this.prisma.user.findUnique({
          where: { firebaseUid },
          select: { role: true },
        })
      : null;

    if (user?.role === 'ADMIN') return true;

    throw new ServiceUnavailableException(
      settings.maintenanceMessage ||
        'La plateforme est en maintenance. Réessayez dans quelques instants.',
    );
  }
}
