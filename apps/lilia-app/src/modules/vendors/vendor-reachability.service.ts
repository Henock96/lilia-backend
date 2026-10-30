import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { pickEscalationPhone } from '../outbox/vendor-contact';

/**
 * Situation de joignabilité d'une boutique, du plus grave au moins grave.
 *
 * - `NO_CHANNEL` : ni appareil inscrit ni mobile de secours — une commande
 *   payée n'atteindra personne ;
 * - `NO_DEVICE` : aucune app inscrite, seul le SMS de secours prévient ;
 * - `STALE_DEVICE` : appareils inscrits, mais aucune inscription récente (app
 *   probablement désinstallée ou jamais rouverte) ;
 * - `NO_SMS_FALLBACK` : app inscrite, mais pas de mobile pour le SMS ;
 * - `OK`.
 */
export type VendorReachabilityStatus =
  | 'NO_CHANNEL'
  | 'NO_DEVICE'
  | 'STALE_DEVICE'
  | 'NO_SMS_FALLBACK'
  | 'OK';

export interface VendorReachabilityRow {
  restaurantId: string;
  nom: string;
  isActive: boolean;
  adminApproved: boolean;
  /** Appareils inscrits pour les notifications (jamais les tokens eux-mêmes). */
  deviceCount: number;
  lastDeviceRegisteredAt: string | null;
  /** Dernière connexion du compte propriétaire. */
  ownerLastLoginAt: string | null;
  /** D'où viendrait le SMS de secours ; jamais le numéro lui-même. */
  smsFallback: 'OWNER' | 'SHOP' | null;
  status: VendorReachabilityStatus;
  needsAction: boolean;
}

/** Au-delà, une inscription est jugée ancienne (app sans doute plus ouverte). */
export const STALE_DEVICE_DAYS = 30;

const SEVERITY: Record<VendorReachabilityStatus, number> = {
  NO_CHANNEL: 0,
  NO_DEVICE: 1,
  STALE_DEVICE: 2,
  NO_SMS_FALLBACK: 3,
  OK: 4,
};

export function classifyReachability(input: {
  deviceCount: number;
  lastDeviceRegisteredAt: Date | null;
  smsFallback: 'OWNER' | 'SHOP' | null;
  now: Date;
}): VendorReachabilityStatus {
  if (input.deviceCount === 0) {
    return input.smsFallback ? 'NO_DEVICE' : 'NO_CHANNEL';
  }
  const staleBefore = input.now.getTime() - STALE_DEVICE_DAYS * 86_400_000;
  if (
    !input.lastDeviceRegisteredAt ||
    input.lastDeviceRegisteredAt.getTime() < staleBefore
  ) {
    return 'STALE_DEVICE';
  }
  return input.smsFallback ? 'OK' : 'NO_SMS_FALLBACK';
}

/**
 * Joignabilité des boutiques pour les commandes (audit du 28/10/2026, F-03).
 *
 * Répond à la question que l'installation des apps vendeurs pose : « si une
 * commande payée arrive maintenant, qui sera prévenu ? ». Une réponse fondée
 * sur les inscriptions de l'app, pas sur la réception réelle : FCM ne dit pas
 * si une notification a été affichée.
 *
 * Projection en liste blanche : ni token FCM, ni numéro de téléphone.
 */
@Injectable()
export class VendorReachabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(now = new Date()): Promise<VendorReachabilityRow[]> {
    const vendors = await this.prisma.restaurant.findMany({
      select: {
        id: true,
        nom: true,
        isActive: true,
        adminApproved: true,
        phone: true,
        owner: {
          select: {
            phone: true,
            lastLogin: true,
            fcmTokens: { select: { lastRegisteredAt: true } },
          },
        },
      },
      orderBy: { nom: 'asc' },
    });

    return vendors
      .map((v) => {
        const devices = v.owner.fcmTokens;
        const last = devices.reduce<Date | null>(
          (max, d) =>
            !max || d.lastRegisteredAt > max ? d.lastRegisteredAt : max,
          null,
        );
        const smsFallback =
          pickEscalationPhone({
            ownerPhone: v.owner.phone,
            shopPhone: v.phone,
          })?.source ?? null;
        const status = classifyReachability({
          deviceCount: devices.length,
          lastDeviceRegisteredAt: last,
          smsFallback,
          now,
        });
        return {
          restaurantId: v.id,
          nom: v.nom,
          isActive: v.isActive,
          adminApproved: v.adminApproved,
          deviceCount: devices.length,
          lastDeviceRegisteredAt: last?.toISOString() ?? null,
          ownerLastLoginAt: v.owner.lastLogin?.toISOString() ?? null,
          smsFallback,
          status,
          needsAction: status !== 'OK',
        };
      })
      .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
  }
}
