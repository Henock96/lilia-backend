import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminAuditAction, Prisma, Role } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { CATALOG_CHANGED, CatalogChangedEvent } from '../events/catalog-events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import {
  AttachModifierGroupsDto,
  CreateModifierGroupDto,
  ModifierOptionInputDto,
  ReorderModifierGroupsDto,
  SetModifierOptionAvailabilityDto,
  UpdateModifierGroupDto,
} from './dto/modifier-group.dto';
import { MODIFIER_LIMITS } from './modifier-selection';

type Tx = Prisma.TransactionClient;

/** La bibliothèque telle que la lisent l'éditeur vendeur et l'admin. */
const LIBRARY_GROUP_SELECT = {
  id: true,
  restaurantId: true,
  name: true,
  minSelect: true,
  maxSelect: true,
  displayOrder: true,
  updatedAt: true,
  options: {
    where: { deletedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      priceDeltaXaf: true,
      maxQuantity: true,
      isAvailable: true,
      displayOrder: true,
    },
  },
  products: {
    where: { product: { deletedAt: null } },
    orderBy: { displayOrder: 'asc' },
    select: {
      displayOrder: true,
      product: { select: { id: true, nom: true } },
    },
  },
} as const satisfies Prisma.ModifierGroupSelect;

/**
 * F3-09 — gestion des options par le vendeur (et par l'ADMIN pour l'aider).
 *
 * ## Propriété
 *
 * Le vendeur cible vient **toujours** de
 * `RestaurantAccessService.resolveTargetRestaurant` — l'arbitre unique des
 * écritures au catalogue — jamais du corps de la requête. Chaque requête
 * suivante est ensuite bornée à `restaurantId` : un identifiant de groupe ou
 * d'option d'un autre vendeur répond 404, comme s'il n'existait pas. La base
 * double le contrôle (FK composites de `ProductModifierGroup`).
 *
 * ## Déploiement
 *
 * Un RESTAURATEUR n'écrit que si `modifiersManagementEnabled` : l'éditeur ne
 * s'ouvre qu'après publication des apps clientes (Q6). Un ADMIN peut préparer
 * une carte avant : sans `modifiersEnabled`, rien n'en est visible ni exigé.
 *
 * ## Ordre de verrouillage (voir `lockModifierRows`)
 *
 * Attaches → groupe → options → lignes de panier. Le checkout prend les mêmes
 * tables dans le même ordre (en partagé) : les deux ne peuvent pas
 * s'interbloquer, et une écriture qui arrive pendant un checkout attend sa fin.
 *
 * ## Suppression
 *
 * Retirer une option (ou un groupe, ou détacher un groupe d'un produit) purge
 * dans la **même transaction** les lignes de panier qui la portent — la ligne
 * ENTIÈRE, jamais la seule `CartItemOption` : « Poulet + Alloco » amputé de son
 * alloco deviendrait un autre plat, moins cher, que le client n'a pas choisi.
 * Déjà commandée une fois, l'option est retirée logiquement (`deletedAt`) ; les
 * commandes gardent de toute façon leur copie (`OrderItemOption`).
 *
 * Chaque écriture émet `CATALOG_CHANGED` (cache du site) et, faite par un
 * ADMIN pour un vendeur, `VENDOR_CATALOG_EDITED` dans le journal d'audit.
 */
@Injectable()
export class ModifiersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RestaurantAccessService,
    private readonly audit: AdminAuditService,
    private readonly eventEmitter: EventEmitter2,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  // ─── Lecture ────────────────────────────────────────────────────────────────

  /** Bibliothèque du vendeur — options en rupture comprises, supprimées exclues. */
  async list(firebaseUid: string, restaurantId?: string) {
    const restaurant = await this.access.resolveTargetRestaurant(
      firebaseUid,
      restaurantId,
    );
    const [groups, settings] = await Promise.all([
      this.prisma.modifierGroup.findMany({
        where: { restaurantId: restaurant.id, deletedAt: null },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: LIBRARY_GROUP_SELECT,
      }),
      this.platformSettings.getSettings(),
    ]);
    return {
      data: groups.map(toLibraryView),
      meta: {
        restaurantId: restaurant.id,
        modifiersEnabled: settings.modifiersEnabled,
        modifiersManagementEnabled: settings.modifiersManagementEnabled,
        limits: MODIFIER_LIMITS,
      },
    };
  }

  // ─── Écritures ──────────────────────────────────────────────────────────────

  async createGroup(
    firebaseUid: string,
    role: Role,
    dto: CreateModifierGroupDto,
  ) {
    const target = await this.writeTarget(firebaseUid, role, dto.restaurantId);
    assertCardinality(dto.minSelect, dto.maxSelect, dto.options.length);
    assertNoDuplicateNames(dto.options);

    const created = await this.prisma.$transaction(async (tx) => {
      // Plafond Q8 compté sous verrou du vendeur : deux créations simultanées
      // ne franchissent pas ensemble la 30ᵉ place.
      await tx.$queryRaw`SELECT id FROM "Restaurant" WHERE id = ${target.id} FOR UPDATE`;
      const count = await tx.modifierGroup.count({
        where: { restaurantId: target.id, deletedAt: null },
      });
      if (count >= MODIFIER_LIMITS.MAX_GROUPS_PER_VENDOR) {
        throw new ConflictException({
          message: `${MODIFIER_LIMITS.MAX_GROUPS_PER_VENDOR} groupes d'options au maximum par boutique.`,
          code: 'MODIFIER_LIMIT',
        });
      }
      return tx.modifierGroup.create({
        data: {
          restaurantId: target.id,
          name: dto.name,
          minSelect: dto.minSelect,
          maxSelect: dto.maxSelect,
          displayOrder: count,
          options: {
            create: dto.options.map((option, index) => ({
              name: option.name,
              priceDeltaXaf: option.priceDeltaXaf,
              maxQuantity: option.maxQuantity ?? 1,
              isAvailable: option.isAvailable ?? true,
              displayOrder: index,
            })),
          },
        },
        select: LIBRARY_GROUP_SELECT,
      });
    });

    await this.after(firebaseUid, target, 'modifier.group.created', {
      action: 'create',
      groupId: created.id,
    });
    return { data: toLibraryView(created), message: "Groupe d'options créé" };
  }

  async updateGroup(
    firebaseUid: string,
    role: Role,
    groupId: string,
    dto: UpdateModifierGroupDto,
  ) {
    const target = await this.writeTarget(firebaseUid, role, dto.restaurantId);
    if (dto.options) assertNoDuplicateNames(dto.options);

    const { group, purged } = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockGroup(tx, target.id, groupId);
      const live = await tx.modifierOption.findMany({
        where: { groupId, deletedAt: null },
        select: { id: true },
      });
      // Verrou exclusif sur les options : un checkout en cours finit d'abord.
      await lockOptionsForUpdate(
        tx,
        live.map((option) => option.id),
      );

      let purged = 0;
      let liveCount = live.length;
      if (dto.options) {
        const liveIds = new Set(live.map((option) => option.id));
        const unknown = dto.options.find((o) => o.id && !liveIds.has(o.id));
        if (unknown) {
          throw new NotFoundException(
            `Option « ${unknown.name} » introuvable dans ce groupe.`,
          );
        }
        const kept = new Set(dto.options.filter((o) => o.id).map((o) => o.id!));
        const removed = [...liveIds].filter((id) => !kept.has(id));
        purged = await this.retireOptions(tx, removed);
        for (const [index, option] of dto.options.entries()) {
          const data = {
            name: option.name,
            priceDeltaXaf: option.priceDeltaXaf,
            maxQuantity: option.maxQuantity ?? 1,
            ...(option.isAvailable !== undefined && {
              isAvailable: option.isAvailable,
            }),
            displayOrder: index,
          };
          if (option.id) {
            await tx.modifierOption.update({ where: { id: option.id }, data });
          } else {
            await tx.modifierOption.create({ data: { ...data, groupId } });
          }
        }
        liveCount = dto.options.length;
      }

      assertCardinality(
        dto.minSelect ?? current.minSelect,
        dto.maxSelect ?? current.maxSelect,
        liveCount,
      );
      const group = await tx.modifierGroup.update({
        where: { id: groupId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.minSelect !== undefined && { minSelect: dto.minSelect }),
          ...(dto.maxSelect !== undefined && { maxSelect: dto.maxSelect }),
        },
        select: LIBRARY_GROUP_SELECT,
      });
      return { group, purged };
    });

    await this.after(firebaseUid, target, 'modifier.group.updated', {
      action: 'update',
      groupId,
      purgedCartLines: purged,
    });
    return {
      data: toLibraryView(group),
      meta: { purgedCartLines: purged },
      message: "Groupe d'options mis à jour",
    };
  }

  async removeGroup(
    firebaseUid: string,
    role: Role,
    groupId: string,
    restaurantId?: string,
  ) {
    const target = await this.writeTarget(firebaseUid, role, restaurantId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Ordre : attaches → groupe → options → lignes de panier.
      await tx.$queryRaw`
        SELECT 1 FROM "ProductModifierGroup"
         WHERE "groupId" = ${groupId}
         ORDER BY "productId" FOR UPDATE`;
      await this.lockGroup(tx, target.id, groupId);
      const options = await tx.modifierOption.findMany({
        where: { groupId },
        select: { id: true },
      });
      const optionIds = options.map((option) => option.id);
      await lockOptionsForUpdate(tx, optionIds);

      const purged = await purgeCartLines(tx, optionIds);
      await tx.productModifierGroup.deleteMany({ where: { groupId } });

      const ordered = await tx.orderItemOption.count({
        where: { optionId: { in: optionIds } },
      });
      if (ordered > 0) {
        const now = new Date();
        await tx.modifierOption.updateMany({
          where: { groupId, deletedAt: null },
          data: { deletedAt: now },
        });
        await tx.modifierGroup.update({
          where: { id: groupId },
          data: { deletedAt: now },
        });
        return { purged, soft: true };
      }
      await tx.modifierGroup.delete({ where: { id: groupId } });
      return { purged, soft: false };
    });

    await this.after(firebaseUid, target, 'modifier.group.deleted', {
      action: 'delete',
      groupId,
      soft: outcome.soft,
      purgedCartLines: outcome.purged,
    });
    return {
      data: { id: groupId, deleted: true, soft: outcome.soft },
      meta: { purgedCartLines: outcome.purged },
      message: "Groupe d'options supprimé",
    };
  }

  /** « Plus d'alloco ce soir » — un geste, aucune ligne de panier touchée. */
  async setOptionAvailability(
    firebaseUid: string,
    role: Role,
    optionId: string,
    dto: SetModifierOptionAvailabilityDto,
  ) {
    const target = await this.writeTarget(firebaseUid, role, dto.restaurantId);
    const { count } = await this.prisma.modifierOption.updateMany({
      where: {
        id: optionId,
        deletedAt: null,
        group: { restaurantId: target.id, deletedAt: null },
      },
      data: { isAvailable: dto.isAvailable },
    });
    if (count === 0) throw new NotFoundException('Option introuvable.');

    await this.after(firebaseUid, target, 'modifier.option.availability', {
      action: 'availability',
      optionId,
      isAvailable: dto.isAvailable,
    });
    return {
      data: { id: optionId, isAvailable: dto.isAvailable },
      message: dto.isAvailable ? 'Option remise en vente' : 'Option en rupture',
    };
  }

  /**
   * Groupes attachés à un produit, dans l'ordre voulu — remplacement complet,
   * idempotent. Détacher un groupe purge les lignes de panier de ce produit
   * qui portent une de ses options.
   */
  async setProductGroups(
    firebaseUid: string,
    role: Role,
    productId: string,
    dto: AttachModifierGroupsDto,
  ) {
    const target = await this.writeTarget(firebaseUid, role, dto.restaurantId);

    const purged = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, restaurantId: target.id, deletedAt: null },
        select: { id: true },
      });
      if (!product) throw new NotFoundException('Produit introuvable.');

      await tx.$queryRaw`
        SELECT 1 FROM "ProductModifierGroup"
         WHERE "productId" = ${productId}
         ORDER BY "groupId" FOR UPDATE`;
      const owned = await tx.modifierGroup.findMany({
        where: {
          id: { in: dto.groupIds },
          restaurantId: target.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (owned.length !== dto.groupIds.length) {
        throw new ForbiddenException(
          "Certains groupes d'options n'appartiennent pas à ce vendeur.",
        );
      }

      const current = await tx.productModifierGroup.findMany({
        where: { productId },
        select: { groupId: true },
      });
      const wanted = new Set(dto.groupIds);
      const detached = current
        .map((attach) => attach.groupId)
        .filter((groupId) => !wanted.has(groupId));

      let purged = 0;
      if (detached.length > 0) {
        const { count } = await tx.cartItem.deleteMany({
          where: {
            productId,
            options: { some: { option: { groupId: { in: detached } } } },
          },
        });
        purged = count;
        await tx.productModifierGroup.deleteMany({
          where: { productId, groupId: { in: detached } },
        });
      }
      for (const [index, groupId] of dto.groupIds.entries()) {
        await tx.productModifierGroup.upsert({
          where: { productId_groupId: { productId, groupId } },
          create: {
            productId,
            groupId,
            restaurantId: target.id,
            displayOrder: index,
          },
          update: { displayOrder: index },
        });
      }
      return purged;
    });

    await this.after(firebaseUid, target, 'modifier.product.attached', {
      action: 'attach',
      productId,
      groupIds: dto.groupIds,
      purgedCartLines: purged,
    });
    return {
      data: { productId, groupIds: dto.groupIds },
      meta: { purgedCartLines: purged },
      message: 'Options du produit mises à jour',
    };
  }

  async reorderGroups(
    firebaseUid: string,
    role: Role,
    dto: ReorderModifierGroupsDto,
  ) {
    const target = await this.writeTarget(firebaseUid, role, dto.restaurantId);
    const owned = await this.prisma.modifierGroup.count({
      where: {
        id: { in: dto.groupIds },
        restaurantId: target.id,
        deletedAt: null,
      },
    });
    if (owned !== dto.groupIds.length) {
      throw new ForbiddenException(
        "Certains groupes d'options n'appartiennent pas à ce vendeur.",
      );
    }
    await this.prisma.$transaction(
      dto.groupIds.map((id, index) =>
        this.prisma.modifierGroup.update({
          where: { id },
          data: { displayOrder: index },
        }),
      ),
    );
    await this.after(firebaseUid, target, 'modifier.group.reordered', {
      action: 'reorder',
      count: dto.groupIds.length,
    });
    return { data: { groupIds: dto.groupIds }, message: 'Ordre mis à jour' };
  }

  // ─── Internes ───────────────────────────────────────────────────────────────

  /**
   * Vendeur cible d'une écriture, et porte du déploiement : un RESTAURATEUR
   * n'écrit que si l'éditeur est ouvert.
   */
  private async writeTarget(
    firebaseUid: string,
    role: Role,
    restaurantId?: string,
  ) {
    const target = await this.access.resolveTargetRestaurant(
      firebaseUid,
      restaurantId,
    );
    if (role !== Role.ADMIN) {
      const settings = await this.platformSettings.getSettings();
      if (!settings.modifiersManagementEnabled) {
        throw new ForbiddenException({
          message:
            'Les options ne sont pas encore ouvertes aux boutiques. Elles le seront dès que les applications clientes seront à jour.',
          code: 'MODIFIERS_MANAGEMENT_DISABLED',
        });
      }
    }
    return target;
  }

  /** Verrou exclusif sur le groupe, borné au vendeur (404 sinon). */
  private async lockGroup(tx: Tx, restaurantId: string, groupId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ModifierGroup"
       WHERE id = ${groupId} AND "restaurantId" = ${restaurantId}
         AND "deletedAt" IS NULL
         FOR UPDATE`;
    if (rows.length === 0) {
      throw new NotFoundException("Groupe d'options introuvable.");
    }
    return tx.modifierGroup.findUniqueOrThrow({
      where: { id: groupId },
      select: { minSelect: true, maxSelect: true },
    });
  }

  /**
   * Retire des options : purge des lignes de panier qui les portent, puis
   * suppression logique si déjà commandées, définitive sinon.
   */
  private async retireOptions(tx: Tx, optionIds: string[]): Promise<number> {
    if (optionIds.length === 0) return 0;
    const purged = await purgeCartLines(tx, optionIds);
    const ordered = await tx.orderItemOption.findMany({
      where: { optionId: { in: optionIds } },
      select: { optionId: true },
      distinct: ['optionId'],
    });
    const orderedIds = ordered.map((row) => row.optionId!);
    const neverOrdered = optionIds.filter((id) => !orderedIds.includes(id));
    if (orderedIds.length > 0) {
      await tx.modifierOption.updateMany({
        where: { id: { in: orderedIds } },
        data: { deletedAt: new Date() },
      });
    }
    if (neverOrdered.length > 0) {
      await tx.modifierOption.deleteMany({
        where: { id: { in: neverOrdered } },
      });
    }
    return purged;
  }

  private async after(
    firebaseUid: string,
    target: { id: string; onBehalfOf: boolean },
    reason: string,
    metadata: Record<string, unknown>,
  ) {
    if (target.onBehalfOf) {
      const actor = await this.prisma.user.findUnique({
        where: { firebaseUid },
        select: { id: true },
      });
      if (actor) {
        await this.audit.record({
          actorId: actor.id,
          action: AdminAuditAction.VENDOR_CATALOG_EDITED,
          targetType: 'Restaurant',
          targetId: target.id,
          metadata: { entity: 'ModifierGroup', ...metadata } as never,
        });
      }
    }
    this.eventEmitter.emit(
      CATALOG_CHANGED,
      new CatalogChangedEvent(target.id, reason),
    );
  }
}

/** Verrou exclusif, dans un ordre total (anti-interblocage). */
async function lockOptionsForUpdate(tx: Tx, optionIds: string[]) {
  if (optionIds.length === 0) return;
  await tx.$queryRaw`
    SELECT 1 FROM "ModifierOption"
     WHERE id IN (${Prisma.join([...optionIds].sort())})
     ORDER BY id FOR UPDATE`;
}

/** Supprime les lignes de panier ENTIÈRES qui portent une de ces options. */
async function purgeCartLines(tx: Tx, optionIds: string[]): Promise<number> {
  if (optionIds.length === 0) return 0;
  const { count } = await tx.cartItem.deleteMany({
    where: { options: { some: { optionId: { in: optionIds } } } },
  });
  return count;
}

/**
 * Cardinalités cohérentes avec le contenu du groupe : un minimum supérieur au
 * nombre d'options rendrait le produit impossible à commander.
 */
function assertCardinality(
  minSelect: number,
  maxSelect: number,
  optionCount: number,
) {
  if (minSelect > maxSelect) {
    throw new BadRequestException(
      'Le nombre minimum de choix ne peut pas dépasser le maximum.',
    );
  }
  if (minSelect > optionCount) {
    throw new BadRequestException(
      `Ce groupe exige ${minSelect} choix mais ne propose que ${optionCount} option${optionCount > 1 ? 's' : ''}.`,
    );
  }
  if (optionCount > MODIFIER_LIMITS.MAX_OPTIONS_PER_GROUP) {
    throw new BadRequestException(
      `${MODIFIER_LIMITS.MAX_OPTIONS_PER_GROUP} options au maximum par groupe.`,
    );
  }
}

function assertNoDuplicateNames(options: ModifierOptionInputDto[]) {
  const seen = new Set<string>();
  for (const option of options) {
    const key = option.name.trim().toLocaleLowerCase('fr');
    if (seen.has(key)) {
      throw new BadRequestException(
        `L'option « ${option.name} » est en double.`,
      );
    }
    seen.add(key);
  }
}

type LibraryRow = Prisma.ModifierGroupGetPayload<{
  select: typeof LIBRARY_GROUP_SELECT;
}>;

function toLibraryView(group: LibraryRow) {
  return {
    id: group.id,
    restaurantId: group.restaurantId,
    name: group.name,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    required: group.minSelect >= 1,
    displayOrder: group.displayOrder,
    updatedAt: group.updatedAt,
    options: group.options,
    products: group.products.map((attach) => attach.product),
  };
}
