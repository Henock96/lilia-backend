import { Order, OrderItem, Restaurant, User } from '@prisma/client';
import { NotionProperties } from '../interfaces/notion-page.types';
import { NOTION_PROPS } from '../notion.constants';

export type OrderWithRelations = Order & {
  items?: OrderItem[];
  restaurant?: Pick<Restaurant, 'nom'> | null;
  user?: Pick<User, 'nom' | 'phone' | 'email'> | null;
};

/**
 * Convertit une commande Prisma en properties Notion.
 * Les valeurs null/undefined sont omises pour éviter d'écraser des champs.
 */
export function mapOrderToNotion(order: OrderWithRelations): NotionProperties {
  const P = NOTION_PROPS.ORDERS;
  const shortId = order.id.slice(-6).toUpperCase();
  const customerLabel =
    order.user?.nom ?? order.user?.email ?? order.userId.slice(-6);
  const itemCount = order.items?.length ?? 0;

  return {
    [P.TITLE]: { title: [{ text: { content: `#${shortId}` } }] },
    [P.PRISMA_ID]: { rich_text: [{ text: { content: order.id } }] },
    [P.STATUS]: { select: { name: order.status } },
    [P.PAYMENT_METHOD]: { select: { name: order.paymentMethod } },
    [P.TOTAL]: { number: Number(order.total ?? 0) },
    [P.SERVICE_FEE]: { number: Number(order.serviceFee ?? 0) },
    [P.DELIVERY_FEE]: { number: Number(order.deliveryFee ?? 0) },
    [P.DISCOUNT]: { number: Number(order.discountAmount ?? 0) },
    [P.SUB_TOTAL]: { number: Number(order.subTotal ?? 0) },
    [P.RESTAURANT]: {
      rich_text: [{ text: { content: order.restaurant?.nom ?? '—' } }],
    },
    [P.CUSTOMER]: {
      rich_text: [{ text: { content: customerLabel } }],
    },
    ...(order.contactPhone || order.user?.phone
      ? {
          [P.PHONE]: {
            phone_number: order.contactPhone ?? order.user?.phone ?? null,
          },
        }
      : {}),
    [P.ITEM_COUNT]: { number: itemCount },
    [P.CREATED_AT]: { date: { start: order.createdAt.toISOString() } },
    ...(order.paidAt
      ? { [P.PAID_AT]: { date: { start: order.paidAt.toISOString() } } }
      : {}),
  };
}
