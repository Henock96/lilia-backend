/* eslint-disable prettier/prettier */
// orders/order-calculator.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  cartSubtotalXaf,
  orderItemSnapshots,
  type OrderItemSnapshot,
  type PricedCartLine,
} from '../modifiers/cart-line-pricing';

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

/** Figé d'une ligne de commande — défini avec le calcul de prix (F3-09). */
export type { OrderItemSnapshot } from '../modifiers/cart-line-pricing';

@Injectable()
export class OrderCalculatorService {

  calculate(
    /**
     * Lignes du panier **déjà résolues** par le moteur d'options : le prix
     * d'une ligne individuelle est `selection.unitPriceXaf` (variante +
     * options), jamais `variant.prix` seul (F3-09).
     */
    lines: readonly PricedCartLine[],
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
    // F3-09 — le sous-total est celui de `cart-line-pricing.ts`, le même que
    // lisent `GET /cart` et l'aperçu promo. Un menu porte son propre prix ;
    // une ligne individuelle, variante + options.
    const subTotal = cartSubtotalXaf(lines);

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

  // Snapshot : capture les prix au moment T — immuable pour l'historique.
  // `prix = snapshotPrice = unitPriceXaf` (options comprises, décision Q1).
  buildOrderItemSnapshots(lines: readonly PricedCartLine[]): OrderItemSnapshot[] {
    return orderItemSnapshots(lines);
  }
}