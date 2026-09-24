import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminAuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { CATALOG_CHANGED, CatalogChangedEvent } from '../events/catalog-events';
import { IN_FLIGHT_ORDER_STATUSES } from '../orders/order-status-groups';
import { MAX_PAUSE_MINUTES } from './dto/vendor-closures.dto';
import { VendorOpeningService } from './vendor-opening.service';

/** Un congé plus long est une suspension, qui est un geste d'administration. */
const MAX_CLOSURE_DAYS = 90;
/** Garde-fou contre une liste sans fin (saisie en boucle, script). */
const MAX_UPCOMING_CLOSURES = 20;

/**
 * Fermetures qui se terminent seules (F3-03) : pause, congés, jours fériés.
 *
 * Aucune n'annule les commandes déjà payées (R-03.4) : elles suivent leur
 * cours. La réponse en donne le nombre, pour que l'interface prévienne.
 */
@Injectable()
export class VendorClosuresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly opening: VendorOpeningService,
    private readonly audit: AdminAuditService,
    private readonly events: EventEmitter2,
  ) {}

  /** Échéance d'une pause, bornée à 7 jours (R-03.2). */
  static pauseEnd(
    input: { minutes?: number; until?: Date },
    now = new Date(),
  ): Date {
    if ((input.minutes == null) === (input.until == null)) {
      throw new BadRequestException(
        'Indiquez soit une durée, soit une heure de reprise.',
      );
    }
    const end =
      input.until ?? new Date(now.getTime() + input.minutes! * 60_000);
    if (end <= now) {
      throw new BadRequestException(
        "L'heure de reprise doit être dans le futur.",
      );
    }
    if (end.getTime() - now.getTime() > MAX_PAUSE_MINUTES * 60_000) {
      throw new BadRequestException(
        'Une pause dure au plus 7 jours. Au-delà, déclarez un congé.',
      );
    }
    return end;
  }

  async pause(
    restaurantId: string,
    input: { minutes?: number; until?: Date; reason?: string },
    actor: { id: string; role: string },
  ) {
    const pausedUntil = VendorClosuresService.pauseEnd(input);
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { pausedUntil, pauseReason: input.reason?.trim() || null },
    });
    const decision = await this.opening.refresh(restaurantId);
    if (actor.role === 'ADMIN') {
      await this.audit.record({
        actorId: actor.id,
        action: AdminAuditAction.VENDOR_PAUSED,
        targetType: 'Restaurant',
        targetId: restaurantId,
        reason: input.reason ?? null,
        metadata: { pausedUntil: pausedUntil.toISOString() },
      });
    }
    this.changed(restaurantId, 'pause');
    return {
      pausedUntil,
      isOpen: decision.open,
      inFlightOrders: await this.inFlightOrders(restaurantId),
    };
  }

  async resume(restaurantId: string) {
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { pausedUntil: null, pauseReason: null },
    });
    const decision = await this.opening.refresh(restaurantId);
    this.changed(restaurantId, 'reprise');
    return {
      pausedUntil: null,
      isOpen: decision.open,
      reason: decision.reason,
    };
  }

  /** Congés en cours et à venir, le plus proche d'abord. */
  listClosures(restaurantId: string) {
    return this.prisma.vendorClosure.findMany({
      where: { restaurantId, endsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
      select: { id: true, startsAt: true, endsAt: true, reason: true },
    });
  }

  async addClosure(
    restaurantId: string,
    input: { startsAt: Date; endsAt: Date; reason?: string },
    actorId: string,
  ) {
    const now = new Date();
    if (input.endsAt <= input.startsAt) {
      throw new BadRequestException('La fin du congé doit suivre son début.');
    }
    if (input.endsAt <= now) {
      throw new BadRequestException('Ce congé est déjà terminé.');
    }
    if (
      input.endsAt.getTime() - input.startsAt.getTime() >
      MAX_CLOSURE_DAYS * 24 * 3600_000
    ) {
      throw new BadRequestException(
        `Un congé dure au plus ${MAX_CLOSURE_DAYS} jours. Au-delà, contactez Lilia.`,
      );
    }
    const upcoming = await this.prisma.vendorClosure.count({
      where: { restaurantId, endsAt: { gt: now } },
    });
    if (upcoming >= MAX_UPCOMING_CLOSURES) {
      throw new BadRequestException(
        `Au plus ${MAX_UPCOMING_CLOSURES} congés à venir. Supprimez-en un d'abord.`,
      );
    }
    const closure = await this.prisma.vendorClosure.create({
      data: {
        restaurantId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason?.trim() || null,
        createdBy: actorId,
      },
      select: { id: true, startsAt: true, endsAt: true, reason: true },
    });
    const decision = await this.opening.refresh(restaurantId);
    this.changed(restaurantId, 'congé');
    return {
      closure,
      isOpen: decision.open,
      inFlightOrders: await this.inFlightOrders(restaurantId),
    };
  }

  async removeClosure(restaurantId: string, closureId: string) {
    // Le congé doit appartenir au vendeur du chemin : l'identifiant seul
    // permettrait de supprimer le congé d'un autre (IDOR).
    const { count } = await this.prisma.vendorClosure.deleteMany({
      where: { id: closureId, restaurantId },
    });
    if (count === 0) throw new NotFoundException('Congé introuvable.');
    const decision = await this.opening.refresh(restaurantId);
    this.changed(restaurantId, 'congé supprimé');
    return { isOpen: decision.open };
  }

  async setClosedOnHolidays(restaurantId: string, closedOnHolidays: boolean) {
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { closedOnHolidays },
    });
    const decision = await this.opening.refresh(restaurantId);
    this.changed(restaurantId, 'jours fériés');
    return { closedOnHolidays, isOpen: decision.open };
  }

  private inFlightOrders(restaurantId: string) {
    return this.prisma.order.count({
      where: { restaurantId, status: { in: [...IN_FLIGHT_ORDER_STATUSES] } },
    });
  }

  /** Le site public affiche l'état ouvert/fermé : son cache doit suivre. */
  private changed(restaurantId: string, reason: string) {
    this.events.emit(
      CATALOG_CHANGED,
      new CatalogChangedEvent(restaurantId, reason),
    );
  }
}
