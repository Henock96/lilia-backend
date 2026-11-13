/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateOpenStatusDto } from './dto/create-restaurant.dto';
import { RESTAURANT_INCLUDE } from './restaurant.includes';
import { RestaurantAccessService } from './restaurant-access.service';
import {
  closedMessage,
  formatUntil,
  VendorOpeningService,
} from '../vendors/vendor-opening.service';
import { currentSlotEnd, withinHours } from '../vendors/vendor-opening.policy';

const MANUAL_CLOSE_REASON = 'Fermeture manuelle';

/**
 * Bouton Ouvrir/Fermer du vendeur — les horaires priment.
 *
 * L'ancien interrupteur (`manualOverride`) figeait l'état posé à la main : un
 * vendeur ouvert à la main restait ouvert après sa fermeture. Désormais :
 *  - « Fermer » pendant le service pose une pause jusqu'à la fin de la plage
 *    en cours (`currentSlotEnd`) ; elle se termine seule ;
 *  - « Ouvrir » lève cette pause, mais ne peut rien hors horaires, pendant un
 *    congé ou un jour férié.
 *
 * Un refus répond 200 avec `meta.refused` et un message, jamais une erreur :
 * l'app vendeurs installée remplace tout l'écran Réglages par une vue d'erreur
 * au moindre échec de cette route. `data.isOpen` est le verdict serveur.
 */
@Injectable()
export class RestaurantOpenStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RestaurantAccessService,
    private readonly opening: VendorOpeningService,
  ) {}

  async update(
    restaurantId: string,
    firebaseUid: string,
    dto: UpdateOpenStatusDto,
    now = new Date(),
  ) {
    const { id } = await this.access.verifyOwnership(restaurantId, firebaseUid);
    const vendor = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id },
      select: {
        nom: true,
        pausedUntil: true,
        operatingHours: {
          select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true },
        },
      },
    });
    const pausedNow = vendor.pausedUntil != null && vendor.pausedUntil > now;
    const inHours = withinHours(vendor.operatingHours, now);

    let message: string;
    let refused = false;

    if (!dto.isOpen) {
      const slotEnd = currentSlotEnd(vendor.operatingHours, now);
      // Une pause plus longue déjà posée (« fermé jusqu'à demain ») est gardée.
      const extend = slotEnd != null && !(pausedNow && vendor.pausedUntil! >= slotEnd);
      await this.prisma.restaurant.update({
        where: { id },
        data: {
          manualOverride: false,
          ...(extend ? { pausedUntil: slotEnd, pauseReason: MANUAL_CLOSE_REASON } : {}),
        },
      });
      await this.opening.refresh(id, now);
      const until = extend ? slotEnd : pausedNow ? vendor.pausedUntil : null;
      message = until
        ? `Fermé jusqu’${formatUntil(until, now)}. Vos horaires reprennent ensuite.`
        : 'Restaurant fermé';
    } else {
      // Seule une pause **pendant le service** se lève : hors horaires, la
      // lever n'ouvrirait rien et effacerait une fermeture voulue.
      const lift = pausedNow && inHours;
      await this.prisma.restaurant.update({
        where: { id },
        data: {
          manualOverride: false,
          ...(lift ? { pausedUntil: null, pauseReason: null } : {}),
        },
      });
      const decision = await this.opening.refresh(id, now);
      if (decision.open) {
        message = 'Restaurant ouvert';
      } else {
        refused = true;
        message =
          decision.reason === 'OUTSIDE_HOURS' || (decision.reason === 'PAUSED' && !inHours)
            ? await this.outsideHoursMessage(id, now)
            : closedMessage(vendor.nom, decision, now);
      }
    }

    const data = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id },
      include: RESTAURANT_INCLUDE,
    });
    return { data, message, meta: { refused } };
  }

  private async outsideHoursMessage(id: string, now: Date): Promise<string> {
    const next = (await this.opening.nextOpeningMany([id], now)).get(id);
    return next
      ? `Vous êtes hors de vos horaires d’ouverture. Prochaine ouverture ${formatUntil(next, now)}.`
      : 'Vous êtes hors de vos horaires d’ouverture. Aucune ouverture prévue : vérifiez vos horaires.';
  }
}
