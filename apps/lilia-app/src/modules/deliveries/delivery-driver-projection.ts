/**
 * Ce que le LIVREUR reçoit d'une course — liste blanche (D-PAY, DEL-002).
 *
 * Les lectures et réponses de mutation destinées au livreur renvoyaient la
 * ligne `Delivery` complète (`driverPayXaf`, `driverSharePercent`,
 * `driverBaseXaf`, modèle et type de rémunération…) et la ligne `Order`
 * complète (commission, frais de service, frais de livraison bruts,
 * subvention vendeur, échéance de versement, imputation d'un échec…).
 *
 * Décision D-PAY du 27/09/2026 : le montant d'une course, le pourcentage et
 * l'assiette sont des données du système et de l'admin ; le livreur n'en voit
 * aucune. Et puisque toute commande est payée d'avance par mobile money, le
 * livreur n'encaisse rien : **aucun montant** ne lui est utile.
 *
 * Liste BLANCHE, pas noire : une colonne ajoutée plus tard à `Delivery` ou à
 * `Order` est masquée par défaut (même règle que `PUBLIC_VENDOR_SELECT`). Le
 * test `driver-route-exposure.spec.ts` fait échouer la CI si une route
 * LIVREUR est ajoutée sans être classée.
 */

/** Champs de `Delivery` utiles à l'exécution de la course. */
const DELIVERY_FIELDS = [
  'id',
  'orderId',
  'status',
  'createdAt',
  'updatedAt',
  'estimatedArrival',
  'acceptedAt',
  'pickedUpAt',
  'deliveredAt',
  'failedAt',
  'lastLatitude',
  'lastLongitude',
  'lastPositionAt',
] as const;

/** Champs de `Order` : destination, contact, horaires — aucun montant. */
const ORDER_FIELDS = [
  'id',
  'status',
  'isDelivery',
  'deliveryAddress',
  'deliveryPrecision',
  'deliveryLandmark',
  'deliveryLatitude',
  'deliveryLongitude',
  'contactPhone',
  'isPreorder',
  'scheduledFor',
  'createdAt',
] as const;

/** Point de retrait : de quoi s'y rendre et l'appeler. */
const RESTAURANT_FIELDS = [
  'id',
  'nom',
  'adresse',
  'phone',
  'vendorType',
  'latitude',
  'longitude',
] as const;

/** Le client, pour l'appeler à la porte. */
const CUSTOMER_FIELDS = ['nom', 'phone'] as const;

/** Un article : ce qu'il faut vérifier au comptoir, sans son prix. */
const ITEM_FIELDS = ['id', 'quantite'] as const;
const PRODUCT_FIELDS = ['nom', 'imageUrl', 'madeToOrder'] as const;

/**
 * Clés qu'aucune réponse destinée à un livreur ne doit porter, à quelque
 * profondeur que ce soit. Sert aux tests ; la projection, elle, ne connaît que
 * sa liste blanche.
 */
export const DRIVER_FORBIDDEN_KEYS = [
  // Rémunération de la course (Delivery).
  'driverPayXaf',
  'driverSharePercent',
  'driverBaseXaf',
  'driverCompensationModel',
  'driverEmploymentType',
  'driverEconomicsFrozenAt',
  'driverSettlementId',
  'payXaf',
  'sharePercent',
  'baseXaf',
  'amountXaf',
  // Économie de la commande (Order).
  'subTotal',
  'total',
  'deliveryFee',
  'deliveryFeeGross',
  'deliveryFeeBaseXaf',
  'serviceFee',
  'commissionPercent',
  'commissionAmount',
  'vendorDeliverySubsidyXaf',
  'vendorFundedDiscountXaf',
  'discountAmount',
  'loyaltyDiscount',
  'loyaltyPointsUsed',
  'referralReward',
  'paymentMethod',
  'payoutDueAt',
  'failureLiability',
  'prix',
] as const;

type Row = Record<string, unknown>;

function pick(source: Row, fields: readonly string[]): Row {
  const out: Row = {};
  for (const f of fields) {
    if (f in source) out[f] = source[f];
  }
  return out;
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectOrder(order: Row): Row {
  const out = pick(order, ORDER_FIELDS);
  if (isRow(order.restaurant)) {
    out.restaurant = pick(order.restaurant, RESTAURANT_FIELDS);
  }
  if (isRow(order.user)) {
    out.user = pick(order.user, CUSTOMER_FIELDS);
  }
  if (Array.isArray(order.items)) {
    out.items = order.items.filter(isRow).map((item) => {
      const projected = pick(item, ITEM_FIELDS);
      if (isRow(item.product)) {
        projected.product = pick(item.product, PRODUCT_FIELDS);
      }
      return projected;
    });
  }
  return out;
}

/**
 * Projette une course (ligne nue ou avec sa commande) pour le livreur.
 * Les clés absentes de la source restent absentes : l'app les lit en
 * nullable.
 */
export function projectDeliveryForDriver(delivery: object): Row {
  const source = delivery as Row;
  const out = pick(source, DELIVERY_FIELDS);
  if (isRow(source.order)) out.order = projectOrder(source.order);
  return out;
}
