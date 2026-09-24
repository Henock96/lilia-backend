import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BRAZZAVILLE_UTC_OFFSET_MS,
  brazzavilleClock,
  datedClosureAt,
  decideOpening,
  OpeningDecision,
} from './vendor-opening.policy';

const OPENING_SELECT = {
  id: true,
  nom: true,
  isOpen: true,
  manualOverride: true,
  pausedUntil: true,
  closedOnHolidays: true,
  operatingHours: {
    select: {
      dayOfWeek: true,
      openTime: true,
      closeTime: true,
      isClosed: true,
    },
  },
} as const;

/** « à 14h30 » ou « au 02/10 à 14h30 », heure de Brazzaville. */
export function formatUntil(date: Date, now = new Date()): string {
  const local = new Date(date.getTime() + BRAZZAVILLE_UTC_OFFSET_MS);
  const localNow = new Date(now.getTime() + BRAZZAVILLE_UTC_OFFSET_MS);
  const hhmm = local.toISOString().slice(11, 16).replace(':', 'h');
  const sameDay =
    local.toISOString().slice(0, 10) === localNow.toISOString().slice(0, 10);
  if (sameDay) return `à ${hhmm}`;
  const [, mm, dd] = local.toISOString().slice(0, 10).split('-');
  return `au ${dd}/${mm} à ${hhmm}`;
}

/**
 * Message de refus au client, nominatif : « fermé » ne dit pas quand revenir.
 */
export function closedMessage(
  vendorName: string,
  decision: OpeningDecision,
  now = new Date(),
): string {
  switch (decision.reason) {
    case 'PAUSED':
      return `« ${vendorName} » est en pause jusqu'${formatUntil(decision.until!, now)}.`;
    case 'CLOSURE':
      return `« ${vendorName} » est fermé jusqu'${formatUntil(decision.until!, now)}.`;
    case 'HOLIDAY':
      return `« ${vendorName} » est fermé aujourd'hui (jour férié).`;
    default:
      return `Le restaurant "${vendorName}" est actuellement fermé.`;
  }
}

/**
 * Applique `decideOpening` (F3-03) : charge ce que la règle lit — horaires,
 * pause, congés en cours, jour férié — en un nombre **fixe** de requêtes,
 * quel que soit le nombre de vendeurs.
 *
 * Sans controller et sans dépendance autre que Prisma : le cron (worker), le
 * checkout et les routes de pause l'instancient chacun dans leur module.
 */
@Injectable()
export class VendorOpeningService {
  constructor(private readonly prisma: PrismaService) {}

  /** Le jour civil de Brazzaville est-il férié ? */
  async isHoliday(now: Date): Promise<boolean> {
    const { isoDate } = brazzavilleClock(now);
    const holiday = await this.prisma.publicHoliday.findUnique({
      where: { date: new Date(`${isoDate}T00:00:00.000Z`) },
      select: { date: true },
    });
    return holiday != null;
  }

  /**
   * Décision pour une liste de vendeurs : 3 requêtes (vendeurs, congés en
   * cours, jour férié), jamais une par vendeur — le cron tourne chaque minute.
   */
  async decideMany(where: Prisma.RestaurantWhereInput, now = new Date()) {
    const [vendors, isHoliday] = await Promise.all([
      this.prisma.restaurant.findMany({ where, select: OPENING_SELECT }),
      this.isHoliday(now),
    ]);
    const closures = vendors.length
      ? await this.prisma.vendorClosure.findMany({
          where: {
            restaurantId: { in: vendors.map((v) => v.id) },
            startsAt: { lte: now },
            endsAt: { gt: now },
          },
          select: { restaurantId: true, startsAt: true, endsAt: true },
        })
      : [];

    return vendors.map((vendor) => ({
      vendor,
      decision: decideOpening({
        now,
        hours: vendor.operatingHours,
        manualOverride: vendor.manualOverride,
        currentIsOpen: vendor.isOpen,
        pausedUntil: vendor.pausedUntil,
        closures: closures.filter((c) => c.restaurantId === vendor.id),
        isHoliday,
        closedOnHolidays: vendor.closedOnHolidays,
      }),
    }));
  }

  async decide(
    restaurantId: string,
    now = new Date(),
  ): Promise<OpeningDecision> {
    const [result] = await this.decideMany({ id: restaurantId }, now);
    if (!result) throw new NotFoundException('Vendeur introuvable.');
    return result.decision;
  }

  /**
   * Recalcule et écrit `isOpen` tout de suite (pause posée ou levée) plutôt
   * que d'attendre le cron : le vendeur qui rouvre doit être commandable
   * immédiatement, et celui qui ferme ne doit plus apparaître ouvert.
   */
  async refresh(
    restaurantId: string,
    now = new Date(),
  ): Promise<OpeningDecision> {
    const [result] = await this.decideMany({ id: restaurantId }, now);
    if (!result) throw new NotFoundException('Vendeur introuvable.');
    await this.write(result.vendor, result.decision);
    return result.decision;
  }

  /**
   * Écrit la décision. Une fermeture **datée** (pause, congé, férié) relâche
   * aussi l'interrupteur manuel : sans cela, la colonne `isOpen` passée à
   * `false` par la fermeture deviendrait, une fois celle-ci terminée, l'« état
   * posé à la main » — et la boutique resterait fermée pour toujours.
   */
  async write(
    vendor: { id: string; isOpen: boolean; manualOverride: boolean },
    decision: OpeningDecision,
  ): Promise<boolean> {
    const dated = ['PAUSED', 'CLOSURE', 'HOLIDAY'].includes(decision.reason);
    const releaseManual = dated && vendor.manualOverride;
    if (decision.open === vendor.isOpen && !releaseManual) return false;
    await this.prisma.restaurant.update({
      where: { id: vendor.id },
      data: {
        isOpen: decision.open,
        ...(releaseManual ? { manualOverride: false } : {}),
      },
    });
    return true;
  }

  /**
   * R-03.3 — une précommande dont l'échéance tombe dans une pause ou un congé
   * est refusée, avec la date de réouverture.
   */
  async datedClosureAt(restaurantId: string, at: Date, now = new Date()) {
    const [vendor, closures] = await Promise.all([
      this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { pausedUntil: true },
      }),
      this.prisma.vendorClosure.findMany({
        where: { restaurantId, startsAt: { lte: at }, endsAt: { gt: at } },
        select: { startsAt: true, endsAt: true },
      }),
    ]);
    return datedClosureAt(at, vendor?.pausedUntil ?? null, closures, now);
  }
}
