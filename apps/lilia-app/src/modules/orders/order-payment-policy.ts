export interface PayableOrder {
  status: string;
  orderFlow?: string | null;
  acceptedAt?: Date | null;
  paymentDueAt?: Date | null;
}

/** State verdict only: endpoints still check ownership, stock and attempts. */
export function orderPaymentAllowed(
  order: PayableOrder,
  now = new Date(),
): boolean {
  if (order.status !== 'EN_ATTENTE') return false;
  if (order.orderFlow !== 'ACCEPT_FIRST') return true;
  return (
    Boolean(order.acceptedAt) &&
    (!order.paymentDueAt || order.paymentDueAt > now)
  );
}
