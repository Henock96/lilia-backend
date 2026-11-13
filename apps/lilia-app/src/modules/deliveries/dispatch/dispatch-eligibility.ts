import { DriverStatus, Prisma, Role, StatusUser } from '@prisma/client';

import { ACTIVE_DELIVERY_STATUSES } from '../delivery-statuses';

/**
 * Éligibilité d'un livreur à une course FCFS — **source unique**.
 *
 * La diffusion FCM, `GET /deliveries/available` et le claim lisent ces
 * mêmes filtres ; le claim les rejoue sous verrou, parce qu'un livreur peut
 * changer d'état entre la liste et l'acceptation.
 *
 * Trois morceaux, pour que le claim puisse dire POURQUOI il refuse (compte,
 * disponibilité, profil) au lieu d'un « non » unique :
 *  - le **compte** : `LIVREUR`, `ACTIVE`, aucun ban programmé ;
 *  - la **disponibilité** : exactement `AVAILABLE` (null, `ON_DELIVERY`,
 *    `OFFLINE` exclus) et aucune course `ASSIGNER|ACCEPTER|EN_TRANSIT` ;
 *  - le **profil** : en service, app capable (`offersEnabledAt`), zone.
 *
 * Zones : un profil sans zone couvre toute la ville (comportement historique,
 * `DriverProfile.zones`). Sinon le quartier de la BOUTIQUE (`Restaurant.
 * quartierId`) doit en faire partie. Une boutique sans quartier n'est
 * proposée qu'aux livreurs sans zone : on ne devine pas une zone, et on
 * n'ignore pas une restriction en silence.
 */
export interface EligibilityOptions {
  /**
   * Diffusion seulement : capacité renouvelée après cet instant (présence,
   * Q7). La liste et le claim ne l'exigent pas — leur requête même prouve
   * que l'app est ouverte.
   */
  presentSince?: Date;
}

export function driverAccountWhere(): Prisma.UserWhereInput {
  return {
    role: Role.LIVREUR,
    statusUser: StatusUser.ACTIVE,
    banPendingAt: null,
  };
}

export function driverAvailabilityWhere(): Prisma.UserWhereInput {
  return {
    driverStatus: DriverStatus.AVAILABLE,
    deliveries: { none: { status: { in: ACTIVE_DELIVERY_STATUSES } } },
  };
}

export function driverProfileWhere(
  restaurantQuartierId: string | null,
  options: EligibilityOptions = {},
): Prisma.DriverProfileWhereInput {
  return {
    isActive: true,
    offersEnabledAt: options.presentSince
      ? { gt: options.presentSince }
      : { not: null },
    OR: [
      { zones: { none: {} } },
      ...(restaurantQuartierId
        ? [{ zones: { some: { id: restaurantQuartierId } } }]
        : []),
    ],
  };
}

/** Les livreurs à qui proposer une course de cette boutique. */
export function eligibleDriverWhere(
  restaurantQuartierId: string | null,
  options: EligibilityOptions = {},
): Prisma.UserWhereInput {
  return {
    AND: [
      driverAccountWhere(),
      driverAvailabilityWhere(),
      {
        driverProfile: {
          is: driverProfileWhere(restaurantQuartierId, options),
        },
      },
    ],
  };
}

/**
 * Le pendant côté courses : celles qu'un livreur aux zones `zoneIds` peut
 * voir. Même règle que `driverProfileWhere`, lue dans l'autre sens.
 */
export function restaurantZoneWhere(zoneIds: string[]): Prisma.OrderWhereInput {
  return zoneIds.length === 0
    ? {}
    : { restaurant: { quartierId: { in: zoneIds } } };
}

/** Pourquoi un livreur ne voit aucune course — l'app l'affiche tel quel. */
export type DriverIneligibility =
  | 'DISPATCH_DISABLED'
  | 'ACCOUNT_BLOCKED'
  | 'PROFILE_INACTIVE'
  | 'APP_NOT_CAPABLE'
  | 'OFFLINE'
  | 'BUSY';

export interface DriverSnapshot {
  role: Role;
  statusUser: StatusUser;
  banPendingAt: Date | null;
  driverStatus: DriverStatus | null;
  profile: { isActive: boolean; offersEnabledAt: Date | null } | null;
  activeDeliveries: number;
}

/**
 * Diagnostic lisible des mêmes règles, pour un livreur déjà chargé. Ne
 * remplace pas les filtres Prisma ci-dessus : il explique, eux décident.
 */
export function driverIneligibility(
  d: DriverSnapshot,
  dispatchEnabled: boolean,
): DriverIneligibility | null {
  if (!dispatchEnabled) return 'DISPATCH_DISABLED';
  if (
    d.role !== Role.LIVREUR ||
    d.statusUser !== StatusUser.ACTIVE ||
    d.banPendingAt
  ) {
    return 'ACCOUNT_BLOCKED';
  }
  if (!d.profile?.isActive) return 'PROFILE_INACTIVE';
  if (!d.profile.offersEnabledAt) return 'APP_NOT_CAPABLE';
  if (d.driverStatus === DriverStatus.ON_DELIVERY || d.activeDeliveries > 0) {
    return 'BUSY';
  }
  if (d.driverStatus !== DriverStatus.AVAILABLE) return 'OFFLINE';
  return null;
}
