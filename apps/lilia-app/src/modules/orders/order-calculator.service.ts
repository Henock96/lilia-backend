/* eslint-disable prettier/prettier */
// orders/order-calculator.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';

export interface OrderAmounts {
  subTotal: number;
  deliveryFee: number;
  serviceFee: number;   // ← nouveau
  total: number;
  /**
   * Commission plateforme retenue sur le vendeur, figée à la commande.
   *
   * Elle **ne modifie pas** ce que paie le client : `serviceFee` est un frais
   * ajouté au panier, la commission est un prélèvement sur ce que touche le
   * vendeur. Les confondre ferait payer deux fois la même chose.
   */
  commissionPercent: number;
  commissionAmount: number;
}

export interface OrderItemSnapshot {
  productId: string;
  menuId?: string;
  quantite: number;
  prix: number;
  variant: string;       // label snapshot
  variantId: string;     // ID pour traçabilité
  snapshotPrice: number; // prix au moment de la commande
}

@Injectable()
export class OrderCalculatorService {

  calculate(
    cartItems: any[],
    deliveryFee: number,
    isDelivery: boolean,
    serviceFeePercent: number,
    /**
     * Taux propre au vendeur. `null` (le cas courant) signifie « pas de
     * commission spécifique » : on retombe sur 0, pas sur `serviceFeePercent`,
     * qui décrit un autre flux d'argent.
     */
    commissionPercent: number | null = null,
  ): OrderAmounts {
    const menuGroups = new Map<string, any[]>();
    const individualItems: any[] = [];

    for (const item of cartItems) {
      if (item.menuId && item.menu) {
        if (!menuGroups.has(item.menuId)) menuGroups.set(item.menuId, []);
        menuGroups.get(item.menuId)!.push(item);
      } else {
        individualItems.push(item);
      }
    }

    let subTotal = individualItems.reduce(
      (acc, item) => acc + item.variant.prix * item.quantite,
      0,
    );

    for (const [, groupItems] of menuGroups) {
      // Le prix du menu est porté par le menu, pas par les variants individuels
      subTotal += groupItems[0].menu!.prix * groupItems[0].quantite;
    }

    // Garde défensive (fix H3) : les DTO produit bornent désormais les prix à
    // [0, MAX_PRIX_XAF], mais des lignes antérieures au correctif peuvent
    // exister en base. Un sous-total négatif signifie qu'un prix l'est —
    // on refuse la commande plutôt que d'encaisser un total faussé.
    if (!Number.isFinite(subTotal) || subTotal < 0) {
      throw new BadRequestException(
        'Le montant du panier est invalide. Contactez le support.',
      );
    }

    const fee = isDelivery ? deliveryFee : 0;

    // Commission appliquée sur le subTotal uniquement
    // (pas sur les frais de livraison — c'est la pratique standard)
    const serviceFee = Math.round(subTotal * serviceFeePercent / 100);


    // Prélèvement sur le vendeur, calculé sur le sous-total. Il n'entre pas
    // dans `total` : le client ne le paie pas, il est retenu sur le reversement.
    const effectiveCommission =
      commissionPercent !== null && Number.isFinite(commissionPercent)
        ? Math.min(Math.max(commissionPercent, 0), 50)
        : 0;
    const commissionAmount = Math.round((subTotal * effectiveCommission) / 100);

    return {
      subTotal: Math.round(subTotal),
      deliveryFee: Math.round(fee),
      serviceFee: serviceFee,
      total: Math.round(subTotal + fee + serviceFee),
      commissionPercent: effectiveCommission,
      commissionAmount,
    };
  }

  // Snapshot : capture les prix au moment T — immuable pour l'historique
  buildOrderItemSnapshots(cartItems: any[]): OrderItemSnapshot[] {
    const menuGroups = new Map<string, any[]>();
    const individualItems: any[] = [];

    for (const item of cartItems) {
      if (item.menuId && item.menu) {
        if (!menuGroups.has(item.menuId)) menuGroups.set(item.menuId, []);
        menuGroups.get(item.menuId)!.push(item);
      } else {
        individualItems.push(item);
      }
    }

    const snapshots: OrderItemSnapshot[] = [];

    // Produits individuels : prix = variant.prix
    for (const item of individualItems) {
      snapshots.push({
        productId: item.productId,
        quantite: item.quantite,
        prix: item.variant.prix,
        variant: item.variant.label ?? 'Standard',
        variantId: item.variantId,
        snapshotPrice: item.variant.prix,
      });
    }

    // Menus : le premier item du groupe porte le prix total du menu
    for (const [menuId, groupItems] of menuGroups) {
      const menuPrix = groupItems[0].menu!.prix;
      groupItems.forEach((item, idx) => {
        snapshots.push({
          productId: item.productId,
          menuId,
          quantite: item.quantite,
          prix: idx === 0 ? menuPrix : 0, // logique métier préservée
          variant: item.variant.label ?? 'Standard',
          variantId: item.variantId,
          snapshotPrice: idx === 0 ? menuPrix : 0,
        });
      });
    }

    return snapshots;
  }
}