import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VendorClosuresService } from './vendor-closures.service';
import { closedMessage, formatUntil } from './vendor-opening.service';

/** Pause, congés et messages de refus (F3-03). */
describe('VendorClosuresService.pauseEnd (R-03.2)', () => {
  const now = new Date('2026-09-28T10:00:00.000Z');

  it('une durée en minutes', () => {
    expect(VendorClosuresService.pauseEnd({ minutes: 30 }, now)).toEqual(
      new Date('2026-09-28T10:30:00.000Z'),
    );
  });

  it('une échéance', () => {
    const until = new Date('2026-09-28T15:00:00.000Z');
    expect(VendorClosuresService.pauseEnd({ until }, now)).toEqual(until);
  });

  it.each([
    [{}, 'ni durée ni échéance'],
    [{ minutes: 30, until: new Date('2026-09-28T15:00:00.000Z') }, 'les deux'],
    [{ until: new Date('2026-09-28T09:00:00.000Z') }, 'dans le passé'],
    [{ until: new Date('2026-10-06T10:00:00.000Z') }, 'plus de 7 jours'],
  ])(
    'refuse %p (%s)',
    (input: { minutes?: number; until?: Date }, _label: string) => {
      void _label;
      expect(() => VendorClosuresService.pauseEnd(input, now)).toThrow(
        BadRequestException,
      );
    },
  );
});

describe('VendorClosuresService — congés', () => {
  function build(overrides: Record<string, unknown> = {}) {
    const prisma = {
      vendorClosure: {
        count: jest.fn().mockResolvedValue(0),
        create: jest
          .fn()
          .mockImplementation(({ data }) => ({ id: 'c1', ...data })),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: { count: jest.fn().mockResolvedValue(2) },
      restaurant: { update: jest.fn() },
      ...overrides,
    };
    const opening = { refresh: jest.fn().mockResolvedValue({ open: false }) };
    const events = { emit: jest.fn() };
    const service = new VendorClosuresService(
      prisma as never,
      opening as never,
      { record: jest.fn() } as never,
      events as never,
    );
    return { service, prisma, opening, events };
  }

  const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

  it('déclare un congé, recalcule l’ouverture et compte les commandes en cours (R-03.4)', async () => {
    const { service, opening, events } = build();
    const r = await service.addClosure(
      'r1',
      { startsAt: day('2099-12-24'), endsAt: day('2099-12-31') },
      'u1',
    );
    expect(r.inFlightOrders).toBe(2);
    expect(opening.refresh).toHaveBeenCalledWith('r1');
    expect(events.emit).toHaveBeenCalled();
  });

  it('refuse une fin avant le début', async () => {
    const { service } = build();
    await expect(
      service.addClosure(
        'r1',
        { startsAt: day('2099-12-31'), endsAt: day('2099-12-24') },
        'u1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse un congé de plus de 90 jours', async () => {
    const { service } = build();
    await expect(
      service.addClosure(
        'r1',
        { startsAt: day('2099-01-01'), endsAt: day('2099-06-01') },
        'u1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('supprimer le congé d’un autre vendeur : introuvable (pas d’IDOR)', async () => {
    const { service, prisma } = build({
      vendorClosure: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    });
    await expect(service.removeClosure('r1', 'c-autre')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.vendorClosure.deleteMany).toHaveBeenCalledWith({
      where: { id: 'c-autre', restaurantId: 'r1' },
    });
  });
});

describe('messages de refus au checkout', () => {
  const now = new Date('2026-09-28T10:00:00.000Z'); // 11h00 à Brazzaville

  it('pause du jour : l’heure seule', () => {
    expect(formatUntil(new Date('2026-09-28T13:30:00.000Z'), now)).toBe(
      'à 14h30',
    );
  });

  it('autre jour : la date et l’heure', () => {
    expect(formatUntil(new Date('2026-10-02T07:00:00.000Z'), now)).toBe(
      'au 02/10 à 08h00',
    );
  });

  it('dit quand revenir', () => {
    expect(
      closedMessage(
        'Chez Lili',
        {
          open: false,
          reason: 'PAUSED',
          until: new Date('2026-09-28T13:30:00.000Z'),
        },
        now,
      ),
    ).toBe("« Chez Lili » est en pause jusqu'à 14h30.");
  });
});
