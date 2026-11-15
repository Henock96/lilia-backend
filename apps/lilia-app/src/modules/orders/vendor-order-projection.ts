import { PrismaService } from '../../prisma/prisma.service';

/**
 * Lot C (15/11/2026, D2) — le vendeur ne connaît pas son client.
 *
 * Il prépare une commande identifiée par son **numéro**, jamais par une
 * personne : ni nom, ni téléphone, ni e-mail, ni photo, ni adresse. Le livreur,
 * lui, garde ce qu'il faut pour livrer ; l'admin voit tout.
 *
 * Compatibilité des apps installées (D2.b) : les champs ne disparaissent pas,
 * ils changent de valeur. `user.nom` porte « Client #<numéro> » — l'ancienne
 * app vendeurs l'affiche là où elle affichait le nom — et les autres passent à
 * `null`, que ses modèles lisent déjà comme facultatifs. L'adresse devient le
 * quartier (D2.a) : utile pour savoir où part la commande, sans désigner
 * personne.
 */

/** Même numéro que celui affiché sur la carte de commande de l'app vendeurs. */
export function vendorCustomerLabel(orderId: string): string {
  return `Client #${orderId.slice(0, 8).toUpperCase()}`;
}

/** Champs de `Order` qui désignent le client ou son domicile. */
export const VENDOR_HIDDEN_ORDER_FIELDS = [
  'userId',
  'contactPhone',
  'deliveryAddress',
  'deliveryLandmark',
  'deliveryLatitude',
  'deliveryLongitude',
] as const;

export interface AnonymizedCustomer {
  id: null;
  nom: string;
  phone: null;
  email: null;
  imageUrl: null;
}

export type VendorVisibleOrder<T> = Omit<
  T,
  (typeof VENDOR_HIDDEN_ORDER_FIELDS)[number] | 'user'
> & {
  userId: null;
  contactPhone: null;
  deliveryAddress: string | null;
  deliveryLandmark: null;
  deliveryLatitude: null;
  deliveryLongitude: null;
  user: AnonymizedCustomer;
};

/**
 * Projection pure : `quartierName` est le nom du quartier de livraison, résolu
 * par l'appelant (`null` en retrait ou pour une commande sans quartier).
 */
export function projectOrderForVendor<T extends { id: string }>(
  order: T,
  quartierName: string | null,
): VendorVisibleOrder<T> {
  const {
    userId: _userId,
    contactPhone: _contactPhone,
    deliveryAddress: _deliveryAddress,
    deliveryLandmark: _deliveryLandmark,
    deliveryLatitude: _deliveryLatitude,
    deliveryLongitude: _deliveryLongitude,
    user: _user,
    ...rest
  } = order as T & Record<string, unknown>;
  return {
    ...(rest as Omit<T, (typeof VENDOR_HIDDEN_ORDER_FIELDS)[number] | 'user'>),
    userId: null,
    contactPhone: null,
    deliveryAddress: quartierName,
    deliveryLandmark: null,
    deliveryLatitude: null,
    deliveryLongitude: null,
    user: {
      id: null,
      nom: vendorCustomerLabel(order.id),
      phone: null,
      email: null,
      imageUrl: null,
    },
  };
}

/** Projette une page de commandes : un seul aller-retour pour les quartiers. */
export async function projectOrdersForVendor<
  T extends { id: string; deliveryQuartierId?: string | null },
>(prisma: PrismaService, orders: T[]): Promise<VendorVisibleOrder<T>[]> {
  const ids = [
    ...new Set(
      orders
        .map((o) => o.deliveryQuartierId)
        .filter((id): id is string => !!id),
    ),
  ];
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await prisma.quartier.findMany({
            where: { id: { in: ids } },
            select: { id: true, nom: true },
          })
        ).map((q) => [q.id, q.nom] as const),
  );
  return orders.map((o) =>
    projectOrderForVendor(
      o,
      o.deliveryQuartierId ? (names.get(o.deliveryQuartierId) ?? null) : null,
    ),
  );
}
