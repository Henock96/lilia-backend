import { OrderStatus, Prisma } from '@prisma/client';

/**
 * Verrouille la ligne `Order` (`SELECT … FOR UPDATE`) et rend son statut
 * courant, ou `null` si la commande n'existe pas.
 *
 * **Point de sérialisation unique des mouvements d'argent d'une commande**
 * (fix F-04, Master Audit v1). Trois gestes décident de l'argent d'une même
 * commande et étaient jusqu'ici arbitrés par des lectures faites HORS
 * transaction :
 *
 *   - le reversement au vendeur (`RestaurantPayoutService.requestPayout`) ;
 *   - l'exécution du remboursement client (`RefundExecutionService.execute`) ;
 *   - l'annulation de la commande (`OrderLifecycleService`, dont l'`UPDATE`
 *     conditionnel prend lui aussi ce verrou).
 *
 * Ils prennent désormais tous le verrou de CETTE ligne avant de décider : le
 * second attend le commit du premier, puis relit un état à jour. Aucun ne peut
 * plus décider sur la foi d'un état que l'autre est en train de changer.
 *
 * ⚠️ À appeler au début d'une transaction, avant toute autre écriture sur des
 * lignes liées à la commande — l'ordre commun des verrous est ce qui évite
 * l'interblocage.
 */
export async function lockOrderRow(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ status: OrderStatus } | null> {
  const rows = await tx.$queryRaw<{ status: OrderStatus }[]>`
    SELECT status FROM "Order" WHERE id = ${orderId} FOR UPDATE
  `;
  return rows[0] ?? null;
}
