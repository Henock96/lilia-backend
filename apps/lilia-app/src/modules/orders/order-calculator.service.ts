/* eslint-disable prettier/prettier */
// orders/order-calculator.service.ts
import { Injectable } from '@nestjs/common';

export const SERVICE_FEE_RATE = 0.08; // 8% — centralisé ici, facile à changer

export interface OrderAmounts {
  subTotal: number;
  deliveryFee: number;
  serviceFee: number;   // ← nouveau
  total: number;
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

    const fee = isDelivery ? deliveryFee : 0;

    // Commission appliquée sur le subTotal uniquement
    // (pas sur les frais de livraison — c'est la pratique standard)
    const serviceFee = Math.round(subTotal * SERVICE_FEE_RATE);


    return {
      subTotal: Math.round(subTotal),
      deliveryFee: Math.round(fee),
      serviceFee: serviceFee,
      total: Math.round(subTotal + fee + serviceFee),
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