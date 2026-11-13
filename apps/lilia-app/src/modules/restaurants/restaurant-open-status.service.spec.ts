import { ForbiddenException } from '@nestjs/common';
import { RestaurantOpenStatusService } from './restaurant-open-status.service';
import { RestaurantAccessService } from './restaurant-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { VendorOpeningService } from '../vendors/vendor-opening.service';

/**
 * Bouton Ouvrir/Fermer du vendeur : les horaires priment.
 *  - « Fermer » pendant le service = pause jusqu'à la fin de la plage ;
 *  - « Ouvrir » hors horaires = refusé (200 + `meta.refused`, jamais 409 :
 *    l'app vendeurs installée passe tout l'écran Réglages en erreur).
 */
describe('RestaurantOpenStatusService', () => {
  /** Heure de Brazzaville (UTC+1), lundi 28/09/2026. */
  const at = (hhmm: string, iso = '2026-09-28') =>
    new Date(new Date(`${iso}T${hhmm}:00.000Z`).getTime() - 3600_000);
  const HOURS = [
    {
      dayOfWeek: 'LUNDI',
      openTime: '08:00',
      closeTime: '22:00',
      isClosed: false,
    },
    {
      dayOfWeek: 'MARDI',
      openTime: '08:00',
      closeTime: '22:00',
      isClosed: false,
    },
  ];

  let prisma: {
    restaurant: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
  };
  let opening: {
    refresh: jest.Mock;
    nextOpeningMany: jest.Mock;
  };
  let access: { verifyOwnership: jest.Mock };
  let service: RestaurantOpenStatusService;

  function setup(vendor: { pausedUntil?: Date | null; hours?: typeof HOURS }) {
    prisma = {
      restaurant: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          nom: 'Chez Lili',
          pausedUntil: vendor.pausedUntil ?? null,
          operatingHours: vendor.hours ?? HOURS,
        }),
        update: jest.fn().mockResolvedValue({ id: 'r1', isOpen: false }),
      },
    };
    opening = {
      refresh: jest.fn(),
      nextOpeningMany: jest.fn(),
    };
    access = { verifyOwnership: jest.fn().mockResolvedValue({ id: 'r1' }) };
    service = new RestaurantOpenStatusService(
      prisma as unknown as PrismaService,
      access as unknown as RestaurantAccessService,
      opening as unknown as VendorOpeningService,
    );
  }

  /** Données écrites par le premier `update` (le second recharge la ligne). */
  const written = () => prisma.restaurant.update.mock.calls[0][0].data;

  it('ownership : un autre vendeur est refusé avant toute écriture', async () => {
    setup({});
    access.verifyOwnership.mockRejectedValue(new ForbiddenException());
    await expect(
      service.update('r1', 'uid-x', { isOpen: false }, at('12:00')),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.restaurant.update).not.toHaveBeenCalled();
  });

  describe('Fermer', () => {
    it('pendant le service : pause jusqu’à la fin de la plage', async () => {
      setup({});
      opening.refresh.mockResolvedValue({
        open: false,
        reason: 'PAUSED',
        until: at('22:00'),
      });
      const res = await service.update(
        'r1',
        'uid',
        { isOpen: false },
        at('12:00'),
      );

      expect(written()).toEqual({
        manualOverride: false,
        pausedUntil: at('22:00'),
        pauseReason: 'Fermeture manuelle',
      });
      expect(opening.refresh).toHaveBeenCalledWith('r1', at('12:00'));
      expect(res.message).toBe(
        'Fermé jusqu’à 22h00. Vos horaires reprennent ensuite.',
      );
      expect(res.meta).toEqual({ refused: false });
    });

    it('une pause plus longue déjà posée n’est pas raccourcie', async () => {
      setup({ pausedUntil: at('10:00', '2026-09-29') });
      opening.refresh.mockResolvedValue({
        open: false,
        reason: 'PAUSED',
        until: null,
      });
      await service.update('r1', 'uid', { isOpen: false }, at('12:00'));
      expect(written()).toEqual({ manualOverride: false });
    });

    it('hors horaires : rien à poser, déjà fermé', async () => {
      setup({});
      opening.refresh.mockResolvedValue({
        open: false,
        reason: 'OUTSIDE_HOURS',
        until: null,
      });
      const res = await service.update(
        'r1',
        'uid',
        { isOpen: false },
        at('23:00'),
      );
      expect(written()).toEqual({ manualOverride: false });
      expect(res.meta).toEqual({ refused: false });
    });
  });

  describe('Ouvrir', () => {
    it('pendant le service, fermé à la main : la pause est levée', async () => {
      setup({ pausedUntil: at('22:00') });
      opening.refresh.mockResolvedValue({
        open: true,
        reason: 'OPEN',
        until: null,
      });
      const res = await service.update(
        'r1',
        'uid',
        { isOpen: true },
        at('12:00'),
      );

      expect(written()).toEqual({
        manualOverride: false,
        pausedUntil: null,
        pauseReason: null,
      });
      expect(res.meta).toEqual({ refused: false });
      expect(res.message).toBe('Restaurant ouvert');
    });

    it('hors horaires : refusé, avec la prochaine ouverture', async () => {
      setup({});
      opening.refresh.mockResolvedValue({
        open: false,
        reason: 'OUTSIDE_HOURS',
        until: null,
      });
      opening.nextOpeningMany.mockResolvedValue(
        new Map([['r1', at('08:00', '2026-09-29')]]),
      );
      const res = await service.update(
        'r1',
        'uid',
        { isOpen: true },
        at('23:00'),
      );

      expect(written()).toEqual({ manualOverride: false });
      expect(res.meta).toEqual({ refused: true });
      expect(res.message).toBe(
        'Vous êtes hors de vos horaires d’ouverture. Prochaine ouverture au 29/09 à 08h00.',
      );
    });

    it('en pause mais hors horaires : la pause reste, refusé', async () => {
      setup({ pausedUntil: at('10:00', '2026-09-29') });
      opening.refresh.mockResolvedValue({
        open: false,
        reason: 'PAUSED',
        until: null,
      });
      opening.nextOpeningMany.mockResolvedValue(new Map([['r1', null]]));
      const res = await service.update(
        'r1',
        'uid',
        { isOpen: true },
        at('23:00'),
      );

      expect(written()).toEqual({ manualOverride: false });
      expect(res.meta).toEqual({ refused: true });
      expect(res.message).toBe(
        'Vous êtes hors de vos horaires d’ouverture. Aucune ouverture prévue : vérifiez vos horaires.',
      );
    });

    it('congé en cours : refusé avec le message de fermeture', async () => {
      setup({});
      const until = at('08:00', '2026-09-29');
      opening.refresh.mockResolvedValue({
        open: false,
        reason: 'CLOSURE',
        until,
      });
      const res = await service.update(
        'r1',
        'uid',
        { isOpen: true },
        at('12:00'),
      );

      expect(res.meta).toEqual({ refused: true });
      expect(res.message).toBe(
        "« Chez Lili » est fermé jusqu'au 29/09 à 08h00.",
      );
    });
  });
});
