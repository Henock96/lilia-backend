import { VendorOpeningService } from './vendor-opening.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `nextOpeningMany` : un nombre **fixe** de requêtes par liste, et le férié lu
 * par jour civil de Brazzaville.
 */
describe('VendorOpeningService.nextOpeningMany', () => {
  // Lundi 28/09/2026 23:00 à Brazzaville (22:00 UTC).
  const now = new Date('2026-09-28T22:00:00.000Z');
  const WEEK = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI'].map(
    (dayOfWeek) => ({
      dayOfWeek,
      openTime: '10:00',
      closeTime: '22:00',
      isClosed: false,
    }),
  );
  const vendor = (id: string, extra = {}) => ({
    id,
    nom: id,
    isOpen: false,
    manualOverride: false,
    pausedUntil: null,
    closedOnHolidays: true,
    operatingHours: WEEK,
    ...extra,
  });

  function build(vendors: unknown[], holidays: string[] = []) {
    const prisma = {
      restaurant: { findMany: jest.fn().mockResolvedValue(vendors) },
      vendorClosure: { findMany: jest.fn().mockResolvedValue([]) },
      publicHoliday: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            holidays.map((d) => ({ date: new Date(`${d}T00:00:00.000Z`) })),
          ),
      },
    };
    return {
      prisma,
      service: new VendorOpeningService(prisma as unknown as PrismaService),
    };
  }

  it('aucune requête pour une liste vide', async () => {
    const { prisma, service } = build([]);
    expect((await service.nextOpeningMany([], now)).size).toBe(0);
    expect(prisma.restaurant.findMany).not.toHaveBeenCalled();
  });

  it('3 requêtes, quel que soit le nombre de vendeurs', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const { prisma, service } = build(ids.map((id) => vendor(id)));
    const result = await service.nextOpeningMany(ids, now);

    expect(result.size).toBe(30);
    expect(prisma.restaurant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vendorClosure.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.publicHoliday.findMany).toHaveBeenCalledTimes(1);
    // Mardi 10:00 Brazzaville = 09:00 UTC.
    expect(result.get('v0')).toEqual(new Date('2026-09-29T09:00:00.000Z'));
  });

  it('férié mardi : mercredi 10:00 ; fermé à la main : null', async () => {
    const { service } = build(
      [vendor('a'), vendor('b', { manualOverride: true })],
      ['2026-09-29'],
    );
    const result = await service.nextOpeningMany(['a', 'b'], now);
    expect(result.get('a')).toEqual(new Date('2026-09-30T09:00:00.000Z'));
    expect(result.get('b')).toBeNull();
  });
});
