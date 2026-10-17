import { PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ReservationSettingsController } from './reservation-settings.controller';

/**
 * Premium (Lot 3) — ce que le contrôleur garantit : le rôle RESTAURATEUR, et
 * un restaurant toujours résolu par le compte connecté (aucun paramètre de
 * chemin ne désigne une boutique). Droits, version et validation sont prouvés
 * sur PostgreSQL réel (`reservation-settings.int-spec.ts`).
 */
describe('ReservationSettingsController', () => {
  const service = {
    getMine: jest.fn(),
    preview: jest.fn(),
    save: jest.fn(),
  };
  const controller = new ReservationSettingsController(service as never);
  const user = { id: 'owner-1' } as never;

  beforeEach(() => jest.clearAllMocks());

  it('réservé au RESTAURATEUR, sur /vendors/me/… (aucun id de boutique)', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, ReservationSettingsController),
    ).toEqual(['RESTAURATEUR']);
    const path = Reflect.getMetadata(
      PATH_METADATA,
      ReservationSettingsController,
    ) as string;
    expect(path).toBe('vendors/me/reservation-settings');
    for (const handler of ['mine', 'preview', 'save'] as const) {
      const sub = Reflect.getMetadata(
        PATH_METADATA,
        ReservationSettingsController.prototype[handler],
      ) as string;
      expect(sub).not.toContain(':');
    }
  });

  it('GET : délègue avec le compte connecté', async () => {
    service.getMine.mockResolvedValue({ configured: false });
    await expect(controller.mine(user)).resolves.toEqual({
      data: { configured: false },
    });
    expect(service.getMine).toHaveBeenCalledWith('owner-1');
  });

  it('preview et PUT : délèguent avec le compte connecté et le corps', async () => {
    const dto = { enabled: false } as never;
    service.preview.mockResolvedValue({ valid: true });
    service.save.mockResolvedValue({ configured: true });

    await expect(controller.preview(user, dto)).resolves.toEqual({
      data: { valid: true },
    });
    expect(service.preview).toHaveBeenCalledWith('owner-1', dto);

    await expect(controller.save(user, dto)).resolves.toEqual({
      data: { configured: true },
      message: 'Configuration des réservations enregistrée.',
    });
    expect(service.save).toHaveBeenCalledWith('owner-1', dto);
  });
});
