import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DayOfWeek,
  Prisma,
  ReservationSettings,
  ReservationSpace,
  ReservationWindow,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { hasEntitlement } from '../subscriptions/entitlements';
import { VendorSubscriptionService } from '../subscriptions/vendor-subscription.service';
import { OpeningHoursRow } from '../vendors/vendor-opening.policy';
import {
  ReservationDraftDto,
  SaveReservationSettingsDto,
} from './dto/reservation-settings.dto';
import {
  evaluateReservationDraft,
  ReservationDraft,
  WEEK_DAYS,
} from './reservation-config';
import {
  RESERVATION_ELIGIBLE_VENDOR_TYPE,
  RESERVATION_ENTITLEMENT,
  RESERVATION_ERROR_CODES as CODES,
  RESERVATION_LIMITS,
} from './reservation-vocab';

const OPENING_SELECT = {
  dayOfWeek: true,
  openTime: true,
  closeTime: true,
  isClosed: true,
} as const;

const SPACE_SELECT = {
  id: true,
  kind: true,
  label: true,
  minGuests: true,
  maxGuests: true,
  seatCount: true,
  maxSeatsPerBooking: true,
  position: true,
  archivedAt: true,
} as const;

type StoredSpace = Pick<ReservationSpace, keyof typeof SPACE_SELECT>;
type StoredWindow = Pick<
  ReservationWindow,
  'dayOfWeek' | 'startTime' | 'endTime'
>;

/**
 * Premium (Lot 3) — configuration de la réservation sur place, côté vendeur.
 *
 * - Le restaurant est **toujours** celui du compte connecté (`ownerId`) :
 *   aucune route n'accepte d'identifiant de boutique.
 * - Lecture et prévisualisation : ouvertes au vendeur Standard (il voit ce
 *   qu'il obtiendrait), jamais d'écriture.
 * - Enregistrement : Premium actif exigé, relu **dans** la transaction, sous
 *   un verrou `Restaurant … FOR NO KEY UPDATE`, incompatible avec le
 *   `FOR UPDATE` de l'attribution et de la révocation d'abonnement (donc
 *   sérialisé avec elles) mais pas avec les insertions de commandes ; version
 *   optimiste contrôlée (409).
 * - Une seule règle de validation : `evaluateReservationDraft`, partagée par
 *   l'aperçu et l'enregistrement.
 *
 * Décisions : `03-approval.md` du Lot 3.
 */
@Injectable()
export class ReservationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: VendorSubscriptionService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  /** État serveur complet : les cinq notions de l'aperçu (03 §4), séparées. */
  async getMine(ownerId: string, now: Date = new Date()) {
    const vendor = await this.resolveVendor(ownerId);
    const [settings, spaces, windows, hours, verdict, platform] =
      await Promise.all([
        this.prisma.reservationSettings.findUnique({
          where: { restaurantId: vendor.id },
        }),
        this.prisma.reservationSpace.findMany({
          where: { restaurantId: vendor.id },
          select: SPACE_SELECT,
        }),
        this.prisma.reservationWindow.findMany({
          where: { restaurantId: vendor.id },
          select: { dayOfWeek: true, startTime: true, endTime: true },
        }),
        this.openingHours(vendor.id),
        this.subscriptions.verdictFor(vendor.id, now),
        this.platformSettings.getSettings(),
      ]);

    const eligible = vendor.vendorType === RESERVATION_ELIGIBLE_VENDOR_TYPE;
    const entitled = hasEntitlement(verdict, RESERVATION_ENTITLEMENT);
    const platformEnabled = platform.reservationsEnabled;
    const base = {
      eligible,
      entitled,
      platformEnabled,
      premiumPaidUntil: verdict.paidUntil,
      limits: RESERVATION_LIMITS,
    };

    if (!settings) {
      return {
        ...base,
        configured: false,
        enabled: false,
        effective: false,
        config: null,
        issues: [],
        preview: null,
      };
    }

    const evaluation = evaluateReservationDraft(
      draftFromStored(settings, spaces, windows),
      {
        existingSpaces: spaces,
        openingHours: hours,
        platformEnabled,
        entitled,
      },
    );
    return {
      ...base,
      configured: true,
      enabled: settings.enabled,
      // « effectif » ne promet aucune disponibilité client (03 §4).
      effective:
        settings.enabled &&
        entitled &&
        platformEnabled &&
        eligible &&
        !evaluation.hasErrors,
      config: projectConfig(settings, spaces, windows),
      issues: evaluation.issues,
      preview: evaluation.preview,
    };
  }

  /** Valide un brouillon sans rien écrire. Premium non exigé (décidé). */
  async preview(
    ownerId: string,
    dto: ReservationDraftDto,
    now: Date = new Date(),
  ) {
    const vendor = await this.resolveVendor(ownerId);
    assertEligible(vendor.vendorType);

    const [existing, spaces, hours, verdict, platform] = await Promise.all([
      this.prisma.reservationSettings.findUnique({
        where: { restaurantId: vendor.id },
        select: { restaurantId: true },
      }),
      this.prisma.reservationSpace.findMany({
        where: { restaurantId: vendor.id },
        select: { id: true, kind: true, label: true, archivedAt: true },
      }),
      this.openingHours(vendor.id),
      this.subscriptions.verdictFor(vendor.id, now),
      this.platformSettings.getSettings(),
    ]);
    const entitled = hasEntitlement(verdict, RESERVATION_ENTITLEMENT);
    const platformEnabled = platform.reservationsEnabled;
    const evaluation = evaluateReservationDraft(toDraft(dto), {
      existingSpaces: spaces,
      openingHours: hours,
      platformEnabled,
      entitled,
    });
    return {
      eligible: true,
      configured: existing !== null,
      enabled: dto.enabled,
      entitled,
      platformEnabled,
      effective:
        dto.enabled && entitled && platformEnabled && !evaluation.hasErrors,
      valid: !evaluation.hasErrors,
      issues: evaluation.issues,
      preview: evaluation.preview,
    };
  }

  /**
   * Remplacement complet de la configuration, dans une transaction :
   * verrou → type de vendeur → droit Premium → version → validation →
   * écritures. Aucune écriture partielle : toute erreur annule tout.
   */
  async save(
    ownerId: string,
    dto: SaveReservationSettingsDto,
    now: Date = new Date(),
  ) {
    const vendor = await this.resolveVendor(ownerId);
    assertEligible(vendor.vendorType);
    const platform = await this.platformSettings.getSettings();

    await this.prisma.$transaction(async (tx) => {
      // `FOR NO KEY UPDATE`, pas `FOR UPDATE` : il reste incompatible avec le
      // `FOR UPDATE` de l'attribution / révocation (sérialisées avec cet
      // enregistrement), mais n'arrête plus le `FOR KEY SHARE` qu'une
      // insertion de commande prend sur ce restaurant au titre de la clé
      // étrangère — un checkout n'attend plus la fin d'un enregistrement, ni
      // l'inverse. Même raison que `driver-row-lock.ts` et `stock.service.ts`.
      // Prouvé en base réelle : `reservation-settings.int-spec.ts`, « concurrence ».
      const locked = await tx.$queryRaw<{ id: string; vendorType: string }[]>`
        SELECT "id", "vendorType"::text AS "vendorType"
        FROM "Restaurant" WHERE "id" = ${vendor.id} FOR NO KEY UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException('Restaurant introuvable.');
      }
      assertEligible(locked[0].vendorType);

      // Droit relu sous le verrou : une révocation concurrente est vue.
      const verdict = await this.subscriptions.verdictFor(vendor.id, now, tx);
      if (!hasEntitlement(verdict, RESERVATION_ENTITLEMENT)) {
        throw new ForbiddenException({
          message:
            'Un abonnement Premium actif est nécessaire pour modifier la réservation sur place.',
          code: CODES.premiumRequired,
        });
      }

      const existing = await tx.reservationSettings.findUnique({
        where: { restaurantId: vendor.id },
        select: { version: true },
      });
      if (dto.version !== (existing?.version ?? 0)) {
        throw conflict();
      }

      const spaces = await tx.reservationSpace.findMany({
        where: { restaurantId: vendor.id },
        select: { id: true, kind: true, label: true, archivedAt: true },
      });
      const hours = await tx.operatingHours.findMany({
        where: { restaurantId: vendor.id },
        select: OPENING_SELECT,
      });

      const evaluation = evaluateReservationDraft(toDraft(dto), {
        existingSpaces: spaces,
        openingHours: hours,
        platformEnabled: platform.reservationsEnabled,
        entitled: true,
      });
      if (evaluation.hasErrors) {
        throw new BadRequestException({
          message: 'La configuration contient des erreurs.',
          code: CODES.invalid,
          issues: evaluation.issues,
        });
      }

      const settingsData = {
        enabled: dto.enabled,
        slotDurationMin: dto.slotDurationMin,
        slotStepMin: dto.slotStepMin,
        bufferMin: dto.bufferMin,
        minLeadMin: dto.minLeadMin,
        maxAdvanceDays: dto.maxAdvanceDays,
        maxPartySize: dto.maxPartySize,
        updatedById: ownerId,
      };
      if (existing) {
        const { count } = await tx.reservationSettings.updateMany({
          where: { restaurantId: vendor.id, version: dto.version },
          data: { ...settingsData, version: { increment: 1 } },
        });
        if (count !== 1) throw conflict();
      } else {
        try {
          await tx.reservationSettings.create({
            data: { restaurantId: vendor.id, ...settingsData },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw conflict();
          }
          throw error;
        }
      }

      const planned = evaluation.plannedSpaces;
      const archiveIds = planned
        .filter((s) => s.action === 'ARCHIVE')
        .map((s) => s.id!);
      if (archiveIds.length > 0) {
        const { count } = await tx.reservationSpace.updateMany({
          where: {
            id: { in: archiveIds },
            restaurantId: vendor.id,
            archivedAt: null,
          },
          data: { archivedAt: now },
        });
        if (count !== archiveIds.length) throw conflict();
      }

      const updates = planned.filter((s) => s.action === 'UPDATE');
      if (updates.length > 0) {
        // Deux ressources qui échangent leurs noms violeraient l'index unique
        // partiel entre deux UPDATE : on libère d'abord leurs clés (chr(1)
        // n'apparaît jamais dans un libellé : `LABEL_INVALID_CHARS` du moteur,
        // évalué avant toute écriture).
        await tx.$executeRaw`
          UPDATE "ReservationSpace" SET "labelKey" = chr(1) || "id"
          WHERE "restaurantId" = ${vendor.id}
            AND "id" IN (${Prisma.join(updates.map((s) => s.id!))})
        `;
        // Une seule instruction pour toutes les ressources : en production,
        // chaque requête de la transaction coûte un aller-retour Render → Neon,
        // verrou `Restaurant` tenu (55 `updateMany` = 55 allers-retours).
        // `kind` dans le WHERE : le moteur refuse déjà tout changement de
        // type ; la base ne l'appliquerait pas non plus (défense en profondeur).
        const rows = updates.map(
          (s) => Prisma.sql`(
            ${s.id!}, ${s.kind}, ${s.label}, ${s.labelKey},
            ${s.minGuests}::int, ${s.maxGuests}::int, ${s.seatCount}::int,
            ${s.maxSeatsPerBooking}::int, ${s.position}::int
          )`,
        );
        const count = await tx.$executeRaw`
          UPDATE "ReservationSpace" AS s SET
            "label" = v.label,
            "labelKey" = v."labelKey",
            "minGuests" = v."minGuests",
            "maxGuests" = v."maxGuests",
            "seatCount" = v."seatCount",
            "maxSeatsPerBooking" = v."maxSeatsPerBooking",
            "position" = v.position,
            "updatedAt" = ${new Date()}
          FROM (VALUES ${Prisma.join(rows)}) AS v(
            id, kind, label, "labelKey", "minGuests", "maxGuests",
            "seatCount", "maxSeatsPerBooking", position
          )
          WHERE s."id" = v.id
            AND s."restaurantId" = ${vendor.id}
            AND s."kind" = v.kind
            AND s."archivedAt" IS NULL
        `;
        if (count !== updates.length) throw conflict();
      }

      const creates = planned.filter((s) => s.action === 'CREATE');
      if (creates.length > 0) {
        try {
          await tx.reservationSpace.createMany({
            data: creates.map((s) => ({
              restaurantId: vendor.id,
              ...spaceData(s),
            })),
          });
        } catch (error) {
          // Index unique partiel des libellés : déjà vérifié par le moteur,
          // traduit ici par défense en profondeur avec le code du module.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw conflict();
          }
          throw error;
        }
      }

      // Les plages ne sont référencées par rien : remplacées (03 §6).
      await tx.reservationWindow.deleteMany({
        where: { restaurantId: vendor.id },
      });
      if (evaluation.windows.length > 0) {
        await tx.reservationWindow.createMany({
          data: evaluation.windows.map((w) => ({
            restaurantId: vendor.id,
            dayOfWeek: w.dayOfWeek as DayOfWeek,
            startTime: w.startTime,
            endTime: w.endTime,
          })),
        });
      }
    });

    return this.getMine(ownerId, now);
  }

  /** Le restaurant du compte connecté — jamais un identifiant de la requête. */
  private async resolveVendor(ownerId: string) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      select: { id: true, vendorType: true },
    });
    if (!vendor) {
      throw new ForbiddenException('Vous devez posséder un vendeur.');
    }
    return vendor;
  }

  private openingHours(restaurantId: string): Promise<OpeningHoursRow[]> {
    return this.prisma.operatingHours.findMany({
      where: { restaurantId },
      select: OPENING_SELECT,
    });
  }
}

function assertEligible(vendorType: string): void {
  if (vendorType !== RESERVATION_ELIGIBLE_VENDOR_TYPE) {
    throw new ForbiddenException({
      message: 'La réservation sur place est réservée aux restaurants.',
      code: CODES.vendorType,
    });
  }
}

function conflict(): ConflictException {
  return new ConflictException({
    message:
      'La configuration a été modifiée entre-temps. Rechargez-la avant d’enregistrer.',
    code: CODES.conflict,
  });
}

function spaceData(s: {
  kind: string;
  label: string;
  labelKey: string;
  minGuests: number | null;
  maxGuests: number | null;
  seatCount: number | null;
  maxSeatsPerBooking: number | null;
  position: number;
}) {
  return {
    kind: s.kind,
    label: s.label,
    labelKey: s.labelKey,
    minGuests: s.minGuests,
    maxGuests: s.maxGuests,
    seatCount: s.seatCount,
    maxSeatsPerBooking: s.maxSeatsPerBooking,
    position: s.position,
  };
}

function toDraft(dto: ReservationDraftDto): ReservationDraft {
  return {
    enabled: dto.enabled,
    slotDurationMin: dto.slotDurationMin,
    slotStepMin: dto.slotStepMin,
    bufferMin: dto.bufferMin,
    minLeadMin: dto.minLeadMin,
    maxAdvanceDays: dto.maxAdvanceDays,
    maxPartySize: dto.maxPartySize,
    spaces: dto.spaces ?? [],
    windows: dto.windows ?? [],
  };
}

/** La configuration enregistrée, relue comme un brouillon (constats du `GET`). */
function draftFromStored(
  settings: ReservationSettings,
  spaces: readonly StoredSpace[],
  windows: readonly StoredWindow[],
): ReservationDraft {
  return {
    enabled: settings.enabled,
    slotDurationMin: settings.slotDurationMin,
    slotStepMin: settings.slotStepMin,
    bufferMin: settings.bufferMin,
    minLeadMin: settings.minLeadMin,
    maxAdvanceDays: settings.maxAdvanceDays,
    maxPartySize: settings.maxPartySize,
    spaces: [...spaces]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        label: s.label,
        minGuests: s.minGuests,
        maxGuests: s.maxGuests,
        seatCount: s.seatCount,
        maxSeatsPerBooking: s.maxSeatsPerBooking,
        archived: s.archivedAt !== null,
      })),
    windows: windows.map((w) => ({ ...w })),
  };
}

function projectSpace(s: StoredSpace) {
  return {
    id: s.id,
    kind: s.kind,
    label: s.label,
    minGuests: s.minGuests,
    maxGuests: s.maxGuests,
    seatCount: s.seatCount,
    maxSeatsPerBooking: s.maxSeatsPerBooking,
    position: s.position,
    archivedAt: s.archivedAt,
  };
}

function projectConfig(
  settings: ReservationSettings,
  spaces: readonly StoredSpace[],
  windows: readonly StoredWindow[],
) {
  const dayIndex = (d: string) => (WEEK_DAYS as readonly string[]).indexOf(d);
  return {
    version: settings.version,
    enabled: settings.enabled,
    slotDurationMin: settings.slotDurationMin,
    slotStepMin: settings.slotStepMin,
    bufferMin: settings.bufferMin,
    minLeadMin: settings.minLeadMin,
    maxAdvanceDays: settings.maxAdvanceDays,
    maxPartySize: settings.maxPartySize,
    updatedAt: settings.updatedAt,
    spaces: spaces
      .filter((s) => s.archivedAt === null)
      .sort((a, b) => a.position - b.position)
      .map(projectSpace),
    archivedSpaces: spaces
      .filter((s) => s.archivedAt !== null)
      .sort((a, b) => b.archivedAt!.getTime() - a.archivedAt!.getTime())
      .map(projectSpace),
    windows: [...windows]
      .sort(
        (a, b) =>
          dayIndex(a.dayOfWeek) - dayIndex(b.dayOfWeek) ||
          a.startTime.localeCompare(b.startTime),
      )
      .map((w) => ({
        dayOfWeek: w.dayOfWeek,
        startTime: w.startTime,
        endTime: w.endTime,
      })),
  };
}
