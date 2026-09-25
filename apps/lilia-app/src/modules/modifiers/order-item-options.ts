import { Prisma } from '@prisma/client';

/**
 * F3-09 — les options figées d'une ligne de commande, telles que les lisent
 * toutes les vues de commande (client, vendeur, admin, reçu, remboursement).
 *
 * Lu depuis `OrderItemOption`, **jamais** depuis le catalogue : renommer,
 * réévaluer ou supprimer une option après la commande ne change rien à ce que
 * montre la commande. `optionId` n'est servi que pour relier, jamais pour
 * relire.
 *
 * Une seule définition, importée partout (motif `vendor-menu.include.ts`) :
 * un `include` recopié à la main dans six services finit par diverger.
 */
export const ORDER_ITEM_OPTIONS_ARGS = {
  orderBy: [{ position: 'asc' }, { id: 'asc' }],
  select: {
    id: true,
    optionId: true,
    groupId: true,
    groupName: true,
    optionName: true,
    priceDeltaXaf: true,
    quantity: true,
    position: true,
  },
} as const satisfies Prisma.OrderItem$optionsArgs;

/** Une option de commande — nom et prix au moment de la commande. */
export type OrderItemOptionView = Prisma.OrderItemOptionGetPayload<
  typeof ORDER_ITEM_OPTIONS_ARGS
>;

/**
 * Libellé court d'une option figée, pour les documents texte (reçu, ticket) :
 * « Œuf ×2 (+600) ». Le supplément affiché est celui de la ligne entière.
 */
export function optionLabel(option: {
  optionName: string;
  quantity: number;
  priceDeltaXaf: number;
}): string {
  const qty = option.quantity > 1 ? ` ×${option.quantity}` : '';
  const delta = option.priceDeltaXaf * option.quantity;
  return delta > 0
    ? `${option.optionName}${qty} (+${delta})`
    : `${option.optionName}${qty}`;
}
