import { Prisma, VendorOffer, VendorOfferStatus } from '@prisma/client';

import { offerLabel } from './vendor-offer-pricing';

/**
 * Projection publique d'une offre boutique (F3-11) — ce que les lectures
 * publiques (`GET /vendors`, `GET /restaurants`…) et le devis en montrent.
 *
 * Fichier sans dépendance Nest : les services de lecture l'importent sans
 * tirer le graphe du service des offres.
 */

/** Ce que les lectures publiques et le devis montrent d'une offre. */
export interface PublicVendorOffer {
  id: string;
  kind: VendorOffer['kind'];
  value: number;
  minSubTotalXaf: number;
  maxDiscountXaf: number | null;
  endsAt: Date;
  label: string;
}

/** Offre retenue pour un panier, montant compris. */
export interface AppliedVendorOffer {
  offer: PublicVendorOffer;
  discountXaf: number;
}

/**
 * Sélection Prisma de l'offre active d'un vendeur, pour les lectures
 * publiques (`PUBLIC_VENDOR_SELECT` + relation). **Jamais** `budgetXaf` ni
 * `spentXaf` : le budget d'un commerçant n'est pas une information publique.
 */
export function activeOfferRelationSelect(now: Date) {
  return {
    vendorOffers: {
      where: {
        status: VendorOfferStatus.ACTIVE,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      take: 1,
      select: {
        id: true,
        kind: true,
        value: true,
        minSubTotalXaf: true,
        maxDiscountXaf: true,
        endsAt: true,
      },
    },
  } as const satisfies Prisma.RestaurantSelect;
}

/**
 * Remplace la relation `vendorOffers` d'une lecture publique par `activeOffer`
 * (ou `null`). Interrupteur éteint : toujours `null`, la relation disparaît.
 */
export function withActiveOffer<T extends { vendorOffers?: unknown }>(
  vendor: T,
  enabled: boolean,
): Omit<T, 'vendorOffers'> & { activeOffer: PublicVendorOffer | null } {
  const { vendorOffers, ...rest } = vendor;
  const first =
    enabled && Array.isArray(vendorOffers) && vendorOffers.length > 0
      ? (vendorOffers[0] as Omit<PublicVendorOffer, 'label'>)
      : null;
  return {
    ...rest,
    activeOffer: first ? { ...first, label: offerLabel(first) } : null,
  };
}
