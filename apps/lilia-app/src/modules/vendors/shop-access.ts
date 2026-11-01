import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Accès aux boutiques — point de contrôle central (durcissement lot 3, point 7).
 *
 * ## Mode compatibilité
 *
 * Un compte agit sur une boutique s'il en est le propriétaire historique
 * (`Restaurant.ownerId`) **ou** s'il en est membre ACTIF avec la permission
 * demandée. Aucun vendeur existant ne perd un accès ; la migration a repris
 * chaque propriétaire en OWNER ACTIVE.
 *
 * Les 124 contrôles `ownerId` du dépôt sont remplacés **module par module**,
 * avec des tests d'isolation entre boutiques. Converti à ce jour : commandes
 * vendeur (liste, fiche, compteur, accepter, refuser, statuts, remise).
 * Tout le reste — numéro de versement, revenus, catalogue, réglages — reste
 * réservé au propriétaire (`ownerId`) tant qu'il n'est pas converti : un
 * membre n'y a donc pas encore accès, ce qui est l'issue sûre.
 *
 * Fonctions et non service injectable : chaque appelant passe son client
 * Prisma (ou sa transaction), sans dépendance de module à module.
 *
 * Listes miroir des CHECK `ShopMembership_role_known` / `_status_known`.
 */
export const SHOP_ROLES = ['OWNER', 'MANAGER', 'STAFF'] as const;
export type ShopRole = (typeof SHOP_ROLES)[number];

export const SHOP_PERMISSIONS = [
  /** Voir et traiter les commandes (accepter, refuser, statuts). */
  'ORDERS',
  /** Catalogue, produits, menus, horaires. */
  'CATALOG',
  /** Stock seulement. */
  'STOCK',
  /** Réglages de la boutique. */
  'SETTINGS',
  /** Numéro de versement, revenus. */
  'PAYOUTS',
  /** Inviter et révoquer des membres. */
  'MEMBERS',
] as const;
export type ShopPermission = (typeof SHOP_PERMISSIONS)[number];

/** Permissions dérivées du rôle — décidées ici, jamais stockées. */
export const ROLE_PERMISSIONS: Record<ShopRole, readonly ShopPermission[]> = {
  OWNER: ['ORDERS', 'CATALOG', 'STOCK', 'SETTINGS', 'PAYOUTS', 'MEMBERS'],
  MANAGER: ['ORDERS', 'CATALOG', 'STOCK', 'SETTINGS'],
  STAFF: ['ORDERS', 'STOCK'],
};

export function roleGrants(role: string, permission: ShopPermission): boolean {
  return (
    (ROLE_PERMISSIONS as Record<string, readonly ShopPermission[]>)[
      role
    ]?.includes(permission) ?? false
  );
}

type Db = Pick<Prisma.TransactionClient, 'restaurant' | 'shopMembership'>;

/** Rôles qui portent une permission (pour filtrer en base). */
function rolesWith(permission: ShopPermission): ShopRole[] {
  return SHOP_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(permission));
}

/** Le compte peut-il exercer `permission` sur cette boutique ? */
export async function canAccessShop(
  db: Db,
  userId: string,
  restaurantId: string,
  permission: ShopPermission,
): Promise<boolean> {
  const owned = await db.restaurant.count({
    where: { id: restaurantId, ownerId: userId },
  });
  if (owned > 0) return true;
  const member = await db.shopMembership.count({
    where: {
      userId,
      restaurantId,
      status: 'ACTIVE',
      role: { in: rolesWith(permission) },
    },
  });
  return member > 0;
}

export async function assertShopAccess(
  db: Db,
  userId: string,
  restaurantId: string,
  permission: ShopPermission,
  opts: {
    /**
     * Propriétaire déjà connu de l'appelant (boutique chargée avec la
     * commande) : le propriétaire passe sans requête — c'est le cas courant.
     */
    knownOwnerId?: string | null;
    message?: string;
  } = {},
): Promise<void> {
  if (opts.knownOwnerId !== undefined && opts.knownOwnerId === userId) return;
  const member =
    opts.knownOwnerId !== undefined
      ? (await db.shopMembership.count({
          where: {
            userId,
            restaurantId,
            status: 'ACTIVE',
            role: { in: rolesWith(permission) },
          },
        })) > 0
      : await canAccessShop(db, userId, restaurantId, permission);
  if (!member) {
    throw new ForbiddenException(
      opts.message ?? "Cette commande n'appartient pas à votre restaurant.",
    );
  }
}

/** Boutiques sur lesquelles le compte exerce `permission`. */
export async function accessibleShopIds(
  db: Db,
  userId: string,
  permission: ShopPermission,
): Promise<string[]> {
  const [owned, memberships] = await Promise.all([
    db.restaurant.findMany({
      where: { ownerId: userId },
      select: { id: true },
    }),
    db.shopMembership.findMany({
      where: { userId, status: 'ACTIVE', role: { in: rolesWith(permission) } },
      select: { restaurantId: true },
    }),
  ]);
  return [
    ...new Set([
      ...owned.map((r) => r.id),
      ...memberships.map((m) => m.restaurantId),
    ]),
  ];
}

/**
 * Membres actifs qui traitent les commandes, **hors propriétaire** : ceux que
 * le push du propriétaire (et son rappel, son SMS) ne couvre pas déjà.
 */
export async function otherOrderRecipients(
  db: Db,
  restaurantId: string,
  ownerId: string,
): Promise<string[]> {
  return (await orderNotificationRecipients(db, restaurantId)).filter(
    (id) => id !== ownerId,
  );
}

/**
 * Comptes à prévenir d'une commande : le propriétaire historique, plus les
 * membres actifs qui traitent les commandes. Le propriétaire toujours en
 * premier : c'est lui que visent les rappels et le SMS de secours.
 */
export async function orderNotificationRecipients(
  db: Db,
  restaurantId: string,
): Promise<string[]> {
  const [shop, members] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { ownerId: true },
    }),
    db.shopMembership.findMany({
      where: {
        restaurantId,
        status: 'ACTIVE',
        role: { in: rolesWith('ORDERS') },
      },
      select: { userId: true },
    }),
  ]);
  return [
    ...new Set([
      ...(shop?.ownerId ? [shop.ownerId] : []),
      ...members.map((m) => m.userId),
    ]),
  ];
}
