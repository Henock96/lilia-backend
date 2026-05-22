import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { MaintenanceGuard } from './maintenance.guard';

function ctx(firebaseUid = 'fb-1'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ firebaseUser: { uid: firebaseUid } }) }),
  } as unknown as ExecutionContext;
}

describe('MaintenanceGuard', () => {
  let guard: MaintenanceGuard;
  let settings: { getSettings: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  beforeEach(() => {
    settings = { getSettings: jest.fn() };
    prisma = { user: { findUnique: jest.fn() } };
    guard = new MaintenanceGuard(settings as any, prisma as any);
  });

  it('laisse passer quand le mode maintenance est inactif (sans requête user)', async () => {
    settings.getSettings.mockResolvedValue({ maintenanceMode: false });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('laisse passer un ADMIN même en mode maintenance', async () => {
    settings.getSettings.mockResolvedValue({ maintenanceMode: true, maintenanceMessage: 'X' });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('bloque un non-admin en mode maintenance avec ServiceUnavailableException', async () => {
    settings.getSettings.mockResolvedValue({ maintenanceMode: true, maintenanceMessage: 'Maintenance en cours' });
    prisma.user.findUnique.mockResolvedValue({ role: 'CLIENT' });
    await expect(guard.canActivate(ctx())).rejects.toThrow(ServiceUnavailableException);
  });
});
