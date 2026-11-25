import { Prisma, VendorSubscription } from '@prisma/client';

import { addOneCalendarMonth } from './billing-period';

export interface StackPeriodsInput {
  restaurantId: string;
  months: number;
  /** Prix d'UN mois, figé sur chaque ligne (jamais saisi). */
  priceXaf: number;
  paymentMethod: string;
  paymentReference?: string | null;
  note?: string | null;
  /** Clé d'idempotence de la i-ième ligne (unique en base). */
  requestKeyFor: (index: number) => string;
  grantedById: string;
  subscriptionPaymentId?: string | null;
  now: Date;
}

/**
 * Empile `months` mois calendaires à la suite de la dernière période encore
 * due du vendeur — une ligne `VendorSubscription` par mois.
 *
 * **L'appelant tient déjà le verrou** `Restaurant … FOR UPDATE` dans `tx` :
 * c'est lui qui sérialise deux attributions simultanées (administrateur,
 * paiement pawaPay). Sans ce verrou, deux empilements liraient la même « fin »
 * et se chevaucheraient.
 *
 * Une ligne par mois (et non une ligne de N mois) : la révocation part du
 * dernier mois, et `paidUntil` reste exact sans autre changement
 * (`entitlements.ts`).
 */
export async function stackPeriods(
  tx: Prisma.TransactionClient,
  input: StackPeriodsInput,
): Promise<VendorSubscription[]> {
  // Prolongation : la nouvelle période commence à la fin de la dernière
  // période encore due, jamais avant — pas de mois payé deux fois sur les
  // mêmes jours.
  const last = await tx.vendorSubscription.findFirst({
    where: {
      restaurantId: input.restaurantId,
      status: 'ACTIVE',
      endsAt: { gt: input.now },
    },
    orderBy: { endsAt: 'desc' },
    select: { endsAt: true },
  });
  let startsAt = last ? last.endsAt : input.now;

  const created: VendorSubscription[] = [];
  for (let i = 0; i < input.months; i++) {
    const endsAt = addOneCalendarMonth(startsAt);
    created.push(
      await tx.vendorSubscription.create({
        data: {
          restaurantId: input.restaurantId,
          plan: 'PREMIUM',
          status: 'ACTIVE',
          startsAt,
          endsAt,
          priceXaf: input.priceXaf,
          paymentMethod: input.paymentMethod,
          paymentReference: input.paymentReference ?? null,
          note: input.note ?? null,
          requestKey: input.requestKeyFor(i),
          grantedById: input.grantedById,
          subscriptionPaymentId: input.subscriptionPaymentId ?? null,
        },
      }),
    );
    startsAt = endsAt;
  }
  return created;
}
