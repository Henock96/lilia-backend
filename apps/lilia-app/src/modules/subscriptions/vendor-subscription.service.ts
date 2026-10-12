import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, Prisma, VendorSubscription } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { addOneCalendarMonth } from './billing-period';
import { subscriptionVerdict, SubscriptionVerdict } from './entitlements';
import { SubscriptionPaymentMethod } from './plans';

export interface GrantSubscriptionInput {
  restaurantId: string;
  adminId: string;
  /** En-tête `Idempotency-Key` : un double envoi rend la même période. */
  requestKey: string;
  paymentMethod: SubscriptionPaymentMethod;
  paymentReference?: string;
  note?: string;
}

export interface GrantResult {
  subscription: VendorSubscription;
  /** `true` si la clé avait déjà servi : rien n'a été créé. */
  replayed: boolean;
}

/**
 * Premium (Lot 2) — périodes d'abonnement payées hors plateforme.
 *
 * Trois garanties, chacune portée par la base plutôt que par un `if` :
 *  · **pas de double mois** : `requestKey` est unique ;
 *  · **pas de chevauchement** : l'attribution verrouille la ligne
 *    `Restaurant` (`FOR UPDATE`) puis empile la période à la fin de la
 *    dernière période active — deux admins simultanés sont sérialisés ;
 *  · **pas de double révocation** : `updateMany … WHERE status = 'ACTIVE'`
 *    puis contrôle de `count`.
 *
 * Chaque geste écrit son `AdminAuditLog` **dans la même transaction** : pas
 * de période accordée ou révoquée sans trace (convention R-01).
 *
 * Le prix n'est jamais saisi : il est lu dans `PlatformSettings` et figé sur
 * la période (règle 6).
 */
@Injectable()
export class VendorSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  async grant(
    input: GrantSubscriptionInput,
    now: Date = new Date(),
  ): Promise<GrantResult> {
    const replay = await this.findReplay(input);
    if (replay) return { subscription: replay, replayed: true };

    const { premiumMonthlyPriceXaf } =
      await this.platformSettings.getSettings();

    try {
      const subscription = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Restaurant" WHERE "id" = ${input.restaurantId} FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new NotFoundException('Vendeur introuvable.');
        }

        // Prolongation : la nouvelle période commence à la fin de la
        // dernière période encore due, jamais avant — pas de mois payé
        // deux fois sur les mêmes jours.
        const last = await tx.vendorSubscription.findFirst({
          where: {
            restaurantId: input.restaurantId,
            status: 'ACTIVE',
            endsAt: { gt: now },
          },
          orderBy: { endsAt: 'desc' },
          select: { endsAt: true },
        });
        const startsAt = last ? last.endsAt : now;

        const created = await tx.vendorSubscription.create({
          data: {
            restaurantId: input.restaurantId,
            plan: 'PREMIUM',
            status: 'ACTIVE',
            startsAt,
            endsAt: addOneCalendarMonth(startsAt),
            priceXaf: premiumMonthlyPriceXaf,
            paymentMethod: input.paymentMethod,
            paymentReference: input.paymentReference ?? null,
            note: input.note ?? null,
            requestKey: input.requestKey,
            grantedById: input.adminId,
          },
        });
        // Journal écrit AVEC la période : un mois payé ne peut pas exister
        // sans trace (l'audit post-commit avalait ses erreurs, et un rejeu
        // rendait ensuite `replayed` sans jamais la réécrire). Si l'audit
        // échoue, rien n'est créé et la même clé peut être renvoyée.
        await tx.adminAuditLog.create({
          data: {
            actorId: input.adminId,
            action: AdminAuditAction.SUBSCRIPTION_GRANTED,
            targetType: 'Restaurant',
            targetId: input.restaurantId,
            reason: input.note ?? null,
            metadata: {
              subscriptionId: created.id,
              plan: created.plan,
              priceXaf: created.priceXaf,
              startsAt: created.startsAt.toISOString(),
              endsAt: created.endsAt.toISOString(),
              paymentMethod: created.paymentMethod,
              paymentReference: created.paymentReference,
            },
          },
        });
        return created;
      });
      return { subscription, replayed: false };
    } catch (error) {
      // Deux envois simultanés de la même clé : le second perd sur l'index
      // unique et rend la période du premier.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.findReplay(input);
        if (winner) return { subscription: winner, replayed: true };
      }
      throw error;
    }
  }

  async revoke(
    restaurantId: string,
    subscriptionId: string,
    adminId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<VendorSubscription> {
    // Même verrou que `grant` : une révocation et une attribution simultanées
    // sur le même vendeur sont sérialisées — l'attribution ne peut pas
    // s'empiler sur une période en train d'être révoquée.
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Restaurant" WHERE "id" = ${restaurantId} FOR UPDATE
      `;
      const subscription =
        locked.length === 0
          ? null
          : await tx.vendorSubscription.findFirst({
              where: { id: subscriptionId, restaurantId },
            });
      if (!subscription) {
        throw new NotFoundException('Période d’abonnement introuvable.');
      }
      if (subscription.status === 'REVOKED') {
        throw new ConflictException('Cette période est déjà révoquée.');
      }
      // Une période terminée n'a plus de droit à retirer : la révoquer
      // réécrirait l'historique sans rien changer pour le vendeur.
      if (subscription.endsAt.getTime() <= now.getTime()) {
        throw new ConflictException(
          'Cette période est terminée : il n’y a plus rien à révoquer.',
        );
      }
      // On révoque en partant du dernier mois. Révoquer un mois suivi d'un
      // autre creuserait un trou : le vendeur perdrait des jours payés, et
      // un mois enregistré ensuite s'empilerait après le trou au lieu de le
      // combler. Les périodes actives restent ainsi une suite continue —
      // ce qui rend exact « Premium jusqu'au … ».
      const later = await tx.vendorSubscription.count({
        where: {
          restaurantId,
          status: 'ACTIVE',
          startsAt: { gte: subscription.endsAt },
        },
      });
      if (later > 0) {
        throw new ConflictException(
          'Un mois est enregistré après celui-ci : révoquez d’abord le mois suivant.',
        );
      }

      const result = await tx.vendorSubscription.updateMany({
        where: { id: subscriptionId, restaurantId, status: 'ACTIVE' },
        data: {
          status: 'REVOKED',
          revokedAt: now,
          revokedById: adminId,
          revokeReason: reason,
        },
      });
      if (result.count === 0) {
        throw new ConflictException('Cette période est déjà révoquée.');
      }
      // Même règle que l'attribution : révocation et trace, ou ni l'une ni
      // l'autre.
      await tx.adminAuditLog.create({
        data: {
          actorId: adminId,
          action: AdminAuditAction.SUBSCRIPTION_REVOKED,
          targetType: 'Restaurant',
          targetId: restaurantId,
          reason,
          metadata: {
            subscriptionId,
            priceXaf: subscription.priceXaf,
            startsAt: subscription.startsAt.toISOString(),
            endsAt: subscription.endsAt.toISOString(),
          },
        },
      });
      return tx.vendorSubscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      });
    });
  }

  /** Historique d'un vendeur (administration) et verdict courant. */
  async listForVendor(restaurantId: string, now: Date = new Date()) {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');

    const periods = await this.prisma.vendorSubscription.findMany({
      where: { restaurantId },
      orderBy: { startsAt: 'desc' },
    });
    const { premiumMonthlyPriceXaf } =
      await this.platformSettings.getSettings();
    return {
      verdict: subscriptionVerdict(periods, now),
      priceXaf: premiumMonthlyPriceXaf,
      periods,
    };
  }

  /**
   * Verdict du vendeur connecté, résolu par son compte — jamais par un
   * identifiant fourni par le client.
   */
  async verdictForOwner(
    ownerId: string,
    now: Date = new Date(),
  ): Promise<SubscriptionVerdict> {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      select: { id: true },
    });
    if (!vendor) {
      throw new ForbiddenException('Vous devez posséder un vendeur.');
    }
    return this.verdictFor(vendor.id, now);
  }

  /** Point d'entrée des droits pour le reste du système (Lot 3 et suivants). */
  async verdictFor(
    restaurantId: string,
    now: Date = new Date(),
  ): Promise<SubscriptionVerdict> {
    const periods = await this.prisma.vendorSubscription.findMany({
      where: { restaurantId, status: 'ACTIVE', endsAt: { gt: now } },
      select: { plan: true, status: true, startsAt: true, endsAt: true },
    });
    return subscriptionVerdict(periods, now);
  }

  /**
   * Période déjà créée avec cette clé. Une clé réutilisée pour un AUTRE
   * vendeur est une erreur de l'appelant, pas un rejeu : 409.
   */
  private async findReplay(
    input: GrantSubscriptionInput,
  ): Promise<VendorSubscription | null> {
    const existing = await this.prisma.vendorSubscription.findUnique({
      where: { requestKey: input.requestKey },
    });
    if (existing && existing.restaurantId !== input.restaurantId) {
      throw new ConflictException(
        'Cette clé d’idempotence a déjà servi pour un autre vendeur.',
      );
    }
    return existing;
  }
}
