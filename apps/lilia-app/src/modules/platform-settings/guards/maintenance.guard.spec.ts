import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { MaintenanceGuard } from './maintenance.guard';
import { PlatformSettingsService } from '../platform-settings.service';

function ctx(user?: { role: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('MaintenanceGuard', () => {
  let guard: MaintenanceGuard;
  let settings: { getSettings: jest.Mock };

  beforeEach(() => {
    settings = { getSettings: jest.fn() };
    guard = new MaintenanceGuard(settings as unknown as PlatformSettingsService);
  });

  it('laisse passer quand le mode maintenance est inactif', async () => {
    settings.getSettings.mockResolvedValue({ maintenanceMode: false });
    await expect(guard.canActivate(ctx({ role: 'CLIENT' }))).resolves.toBe(true);
  });

  it('laisse passer un ADMIN même en mode maintenance', async () => {
    settings.getSettings.mockResolvedValue({
      maintenanceMode: true,
      maintenanceMessage: 'X',
    });
    await expect(guard.canActivate(ctx({ role: 'ADMIN' }))).resolves.toBe(true);
  });

  it('bloque un non-admin en mode maintenance avec ServiceUnavailableException', async () => {
    settings.getSettings.mockResolvedValue({
      maintenanceMode: true,
      maintenanceMessage: 'Maintenance en cours',
    });
    await expect(guard.canActivate(ctx({ role: 'CLIENT' }))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('bloque une requête sans utilisateur synchronisé en mode maintenance', async () => {
    settings.getSettings.mockResolvedValue({
      maintenanceMode: true,
      maintenanceMessage: 'Maintenance en cours',
    });
    await expect(guard.canActivate(ctx(undefined))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
