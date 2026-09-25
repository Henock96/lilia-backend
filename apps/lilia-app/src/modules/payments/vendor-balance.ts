import { Prisma, RefundBearer, VendorBalanceKind } from '@prisma/client';

/**
 * Dette d'un vendeur envers Lilia Food (F3-07).
 *
 * Un versement par commande, une heure après la remise (D5/D6), alors qu'une
 * réclamation reste possible 24 h (D4) : un remboursement à la charge du
 * vendeur arrive souvent APRÈS son versement. Il ne peut plus être retenu sur
 * cette commande-là — il devient une dette, retenue sur le versement suivant.
 *
 * Fonctions sur un client de transaction, sans injection : les remboursements
 * (`refunds/`) et les versements (`payments/`) s'en servent sans dépendre l'un
 * de l'autre. Toutes les écritures sont idempotentes par contrainte d'unicité
 * (`refundId`, `(kind, payoutId)`) : un rejeu ne compte jamais deux fois.
 */

type Tx = Prisma.TransactionClient;

/** Dette courante, en XAF (≥ 0). Solde = Σ amountXaf ; dette = −solde. */
export async function vendorDebtXaf(
  tx: Tx,
  restaurantId: string,
): Promise<number> {
  const { _sum } = await tx.vendorBalanceEntry.aggregate({
    where: { restaurantId },
    _sum: { amountXaf: true },
  });
  return Math.max(0, -(_sum.amountXaf ?? 0));
}

/**
 * Verrou du vendeur, à prendre APRÈS celui de la commande (ordre R3) : deux
 * versements simultanés du même vendeur ne retiennent pas deux fois la même
 * dette.
 */
export async function lockRestaurantRow(
  tx: Tx,
  restaurantId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Restaurant" WHERE id = ${restaurantId} FOR UPDATE`;
}

/**
 * Un remboursement à la charge du vendeur vient d'aboutir : s'il arrive après
 * le versement de sa commande, il devient une dette.
 *
 * Avant le versement, rien à écrire : la retenue se fait sur la commande
 * elle-même (`refundGateForPayout`). Un versement `FAILED` sera relancé et
 * recalculera la retenue ; un versement `PENDING` bloque l'exécution du
 * remboursement (invariant F-04) — seul `SUCCESS` fait naître une dette.
 *
 * @returns `true` si une dette a été écrite par CET appel.
 */
export async function recordClawbackIfDue(
  tx: Tx,
  refund: { id: string; orderId: string; amount: number; bearer: RefundBearer },
): Promise<boolean> {
  if (refund.bearer !== RefundBearer.VENDOR || refund.amount <= 0) return false;
  const payout = await tx.restaurantPayout.findUnique({
    where: { orderId: refund.orderId },
    select: { id: true, status: true, restaurantId: true },
  });
  if (payout?.status !== 'SUCCESS') return false;
  const { count } = await tx.vendorBalanceEntry.createMany({
    data: {
      restaurantId: payout.restaurantId,
      kind: VendorBalanceKind.REFUND_CLAWBACK,
      amountXaf: -refund.amount,
      orderId: refund.orderId,
      refundId: refund.id,
      note: `Remboursement client après versement (commande #${refund.orderId.slice(-6).toUpperCase()})`,
    },
    skipDuplicates: true,
  });
  return count > 0;
}

/** Dette retenue sur un versement : écrite avec lui, dans la même transaction. */
export async function recordDebtSettled(
  tx: Tx,
  params: {
    restaurantId: string;
    payoutId: string;
    orderId: string;
    amountXaf: number;
  },
): Promise<void> {
  if (params.amountXaf <= 0) return;
  await tx.vendorBalanceEntry.create({
    data: {
      restaurantId: params.restaurantId,
      kind: VendorBalanceKind.DEBT_SETTLED,
      amountXaf: params.amountXaf,
      orderId: params.orderId,
      payoutId: params.payoutId,
    },
  });
}

/**
 * Un versement qui retenait de la dette a échoué : l'argent n'est pas parti,
 * la retenue non plus. On compense — jamais on ne supprime une écriture.
 */
export async function restoreDebtOfFailedPayout(
  tx: Tx,
  payout: {
    id: string;
    restaurantId: string;
    orderId: string;
    debtDeductionAmount: number;
  },
): Promise<void> {
  if (payout.debtDeductionAmount <= 0) return;
  await tx.vendorBalanceEntry.createMany({
    data: {
      restaurantId: payout.restaurantId,
      kind: VendorBalanceKind.DEBT_RESTORED,
      amountXaf: -payout.debtDeductionAmount,
      orderId: payout.orderId,
      payoutId: payout.id,
    },
    skipDuplicates: true,
  });
}
