import { RestaurantScheduleService } from './restaurant-schedule.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';
import { VendorOpeningService } from '../vendors/vendor-opening.service';

/**
 * Cron d'ouverture : il écrit le verdict de `decideOpening`, horaires
 * prioritaires, et purge l'ancien drapeau `manualOverride`.
 */
describe('RestaurantScheduleService.handleScheduleCheck', () => {
  function build(
    decisions: Array<{ id: string; isOpen: boolean; open: boolean }>,
  ) {
    const prisma = {
      restaurant: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const cronLock = {
      runExclusively: jest.fn((_k: string, _t: number, fn: () => unknown) =>
        fn(),
      ),
    };
    const opening = {
      decideMany: jest.fn().mockResolvedValue(
        decisions.map((d) => ({
          vendor: { id: d.id, nom: d.id, isOpen: d.isOpen },
          decision: {
            open: d.open,
            reason: d.open ? 'OPEN' : 'OUTSIDE_HOURS',
            until: null,
          },
        })),
      ),
    };
    const service = new RestaurantScheduleService(
      prisma as unknown as PrismaService,
      cronLock as unknown as CronLockService,
      opening as unknown as VendorOpeningService,
    );
    return { prisma, service };
  }

  it('ferme un vendeur ouvert hors horaires, ouvre celui qui doit l’être', async () => {
    const { prisma, service } = build([
      { id: 'tard', isOpen: true, open: false },
      { id: 'matin', isOpen: false, open: true },
      { id: 'stable', isOpen: true, open: true },
    ]);
    await service.handleScheduleCheck();

    expect(prisma.restaurant.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['matin'] } },
      data: { isOpen: true },
    });
    expect(prisma.restaurant.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['tard'] } },
      data: { isOpen: false },
    });
  });

  it('purge l’ancien drapeau manuel, quel que soit le verdict', async () => {
    const { prisma, service } = build([]);
    await service.handleScheduleCheck();

    expect(prisma.restaurant.updateMany).toHaveBeenCalledWith({
      where: { manualOverride: true },
      data: { manualOverride: false },
    });
  });
});
