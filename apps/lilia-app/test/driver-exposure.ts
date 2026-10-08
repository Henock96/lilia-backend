import { DRIVER_FORBIDDEN_KEYS } from '../src/modules/deliveries/delivery-driver-projection';

/**
 * Clés interdites au livreur (D-PAY) présentes dans [value], à toute
 * profondeur, avec leur chemin — `[]` si la réponse est propre.
 */
export function forbiddenDriverKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => forbiddenDriverKeysIn(v, `${path}[${i}]`));
  }
  if (typeof value !== 'object' || value === null || value instanceof Date) {
    return [];
  }
  return Object.entries(value).flatMap(([k, v]) => [
    ...((DRIVER_FORBIDDEN_KEYS as readonly string[]).includes(k)
      ? [`${path}.${k}`]
      : []),
    ...forbiddenDriverKeysIn(v, `${path}.${k}`),
  ]);
}

/**
 * Une course telle que Prisma la rend avec `include` : TOUTES les colonnes
 * économiques remplies, pour qu'une fuite se voie.
 */
export function fullDeliveryRow(status = 'EN_TRANSIT') {
  return {
    id: 'd1',
    orderId: 'o1',
    delivererId: 'liv1',
    status,
    createdAt: new Date('2026-10-08T10:00:00Z'),
    updatedAt: new Date('2026-10-08T10:05:00Z'),
    acceptedAt: new Date('2026-10-08T10:01:00Z'),
    pickedUpAt: null,
    deliveredAt: null,
    lastLatitude: -4.26,
    lastLongitude: 15.24,
    driverBaseXaf: 1000,
    driverCompensationModel: 'PER_DELIVERY',
    driverEmploymentType: 'INDEPENDENT',
    driverSharePercent: 65,
    driverPayXaf: 650,
    driverEconomicsFrozenAt: new Date('2026-10-08T10:01:00Z'),
    driverSettlementId: 'set-1',
    order: {
      id: 'o1',
      userId: 'client1',
      status: 'EN_ROUTE',
      subTotal: 5000,
      deliveryFee: 1000,
      deliveryFeeGross: 1000,
      deliveryFeeBaseXaf: 1000,
      serviceFee: 750,
      total: 6750,
      commissionPercent: 15,
      commissionAmount: 750,
      vendorDeliverySubsidyXaf: 0,
      vendorFundedDiscountXaf: 0,
      discountAmount: 0,
      loyaltyDiscount: 0,
      loyaltyPointsUsed: 0,
      referralReward: 0,
      paymentMethod: 'MTN_MOMO',
      payoutDueAt: new Date('2026-10-09T10:00:00Z'),
      failureLiability: null,
      notes: 'note interne',
      deliveryAddress: 'Moungali, rue 12',
      deliveryLatitude: -4.27,
      deliveryLongitude: 15.25,
      deliveryPrecision: 'EXACT',
      deliveryLandmark: 'portail bleu',
      contactPhone: '+242060000000',
      isPreorder: false,
      scheduledFor: null,
      user: { nom: 'Client', phone: '+242061111111' },
      restaurant: {
        id: 'r1',
        nom: 'Resto',
        adresse: 'Poto-Poto',
        phone: '+242062222222',
        vendorType: 'RESTAURANT',
        latitude: -4.25,
        longitude: 15.26,
        acceptsPreorders: true,
        preorderLeadHours: 2,
        owner: { firebaseUid: 'ownerUid' },
      },
      items: [
        {
          id: 'i1',
          quantite: 2,
          prix: 2500,
          product: { nom: 'Poulet DG', imageUrl: null, madeToOrder: false },
        },
      ],
    },
  };
}
