import { PayoutProvider, Prisma } from '@prisma/client';

/**
 * Écrit le compte de versement d'un vendeur (F-08, F3-08). Un seul endroit,
 * appelé par la première saisie (directe) et par l'approbation d'un
 * changement (4 yeux) : les deux chemins posent le même horodatage, donc la
 * même carence de 24 h avant tout virement.
 */
export async function applyPayoutAccount(
  tx: Prisma.TransactionClient,
  params: {
    restaurantId: string;
    payoutPhoneNumber: string;
    payoutProvider: PayoutProvider;
    payoutAccountName: string | null;
    verifiedById: string;
  },
) {
  return tx.restaurant.update({
    where: { id: params.restaurantId },
    data: {
      payoutPhoneNumber: params.payoutPhoneNumber,
      payoutProvider: params.payoutProvider,
      payoutAccountName: params.payoutAccountName,
      payoutVerifiedAt: new Date(),
      payoutVerifiedById: params.verifiedById,
    },
    select: {
      id: true,
      nom: true,
      payoutPhoneNumber: true,
      payoutProvider: true,
      payoutAccountName: true,
      payoutVerifiedAt: true,
    },
  });
}

/** Charge utile d'un changement de compte : ce que l'approbation autorise. */
export interface PayoutAccountPayload {
  payoutPhoneNumber: string;
  payoutProvider: PayoutProvider;
  payoutAccountName: string | null;
}
