import { Prisma } from '@prisma/client';

/**
 * Ce qu'un livreur voit d'une course **avant** de l'avoir acceptée.
 *
 * Liste blanche, construite champ par champ : la ligne lue ne porte que ce
 * `select`, et la projection n'en recopie qu'une partie. Avant attribution,
 * le livreur décide « j'y vais ou pas » ; il n'a besoin ni de savoir QUI a
 * commandé, ni OÙ exactement, ni COMBIEN :
 *
 *  - **jamais** : nom ou téléphone du client, adresse exacte, repères,
 *    coordonnées GPS (client comme boutique), montants, frais, économie de
 *    la course (D-PAY) ;
 *  - **seulement** : la boutique (nom, type, quartier), le quartier de
 *    livraison, le nombre d'articles, la précommande, l'ancienneté.
 *
 * Le détail complet (contact, destination) n'arrive qu'après le claim, par
 * `projectDeliveryForDriver` — à celui qui a la course, et à lui seul.
 */
export const OFFER_SELECT = {
  id: true,
  createdAt: true,
  dispatchStartedAt: true,
  dispatchRound: true,
  order: {
    select: {
      id: true,
      isPreorder: true,
      scheduledFor: true,
      deliveryQuartierId: true,
      items: { select: { quantite: true } },
      restaurant: {
        select: {
          nom: true,
          vendorType: true,
          quartier: { select: { nom: true } },
        },
      },
    },
  },
} satisfies Prisma.DeliverySelect;

export type OfferRow = Prisma.DeliveryGetPayload<{
  select: typeof OFFER_SELECT;
}>;

export interface DeliveryOfferView {
  deliveryId: string;
  /** Référence courte affichée (#ABC123) — pas l'identifiant de commande. */
  orderRef: string;
  restaurant: { nom: string; vendorType: string; quartier: string | null };
  deliveryQuartier: string | null;
  itemCount: number;
  isPreorder: boolean;
  scheduledFor: string | null;
  /** Course ouverte depuis (≈ passage à PRET). */
  readySince: string;
  /** Recherche en cours depuis (relance comprise). */
  searchingSince: string | null;
  round: number;
}

export function projectOfferForDriver(
  row: OfferRow,
  quartierNames: ReadonlyMap<string, string>,
): DeliveryOfferView {
  const { order } = row;
  return {
    deliveryId: row.id,
    orderRef: `#${order.id.slice(-6).toUpperCase()}`,
    restaurant: {
      nom: order.restaurant.nom,
      vendorType: order.restaurant.vendorType,
      quartier: order.restaurant.quartier?.nom ?? null,
    },
    deliveryQuartier: order.deliveryQuartierId
      ? (quartierNames.get(order.deliveryQuartierId) ?? null)
      : null,
    itemCount: order.items.reduce((sum, item) => sum + item.quantite, 0),
    isPreorder: order.isPreorder,
    scheduledFor: order.scheduledFor?.toISOString() ?? null,
    readySince: row.createdAt.toISOString(),
    searchingSince: row.dispatchStartedAt?.toISOString() ?? null,
    round: row.dispatchRound ?? 0,
  };
}
