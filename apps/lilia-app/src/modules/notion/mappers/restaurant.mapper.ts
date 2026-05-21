import { Restaurant, User } from '@prisma/client';
import { NotionProperties } from '../interfaces/notion-page.types';
import { NOTION_PROPS } from '../notion.constants';

export type RestaurantWithOwner = Restaurant & {
  owner?: Pick<User, 'nom' | 'email' | 'phone'> | null;
  averageRating?: number | null;
  totalReviews?: number | null;
};

export function mapRestaurantToNotion(
  resto: RestaurantWithOwner,
): NotionProperties {
  const P = NOTION_PROPS.RESTAURANTS;
  const ownerLabel =
    resto.owner?.nom ?? resto.owner?.email ?? resto.ownerId.slice(-6);

  return {
    [P.TITLE]: { title: [{ text: { content: resto.nom } }] },
    [P.PRISMA_ID]: { rich_text: [{ text: { content: resto.id } }] },
    [P.OWNER]: { rich_text: [{ text: { content: ownerLabel } }] },
    [P.IS_OPEN]: { checkbox: !!resto.isOpen },
    [P.IS_ACTIVE]: { checkbox: !!resto.isActive },
    [P.AVERAGE_RATING]: { number: Number(resto.averageRating ?? 0) },
    [P.TOTAL_REVIEWS]: { number: Number(resto.totalReviews ?? 0) },
    [P.MIN_ORDER]: { number: Number(resto.minimumOrderAmount ?? 0) },
    [P.DELIVERY_FEE]: { number: Number(resto.fixedDeliveryFee ?? 0) },
    [P.ETA_MIN]: { number: Number(resto.estimatedDeliveryTimeMin ?? 0) },
    [P.ETA_MAX]: { number: Number(resto.estimatedDeliveryTimeMax ?? 0) },
    ...(resto.owner?.phone
      ? { [P.PHONE]: { phone_number: resto.owner.phone } }
      : {}),
    [P.CREATED_AT]: { date: { start: resto.createdAt.toISOString() } },
  };
}
