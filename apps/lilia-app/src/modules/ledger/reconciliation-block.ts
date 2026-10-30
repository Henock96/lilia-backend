import { Prisma } from '@prisma/client';

/**
 * Blocage des versements par le rapprochement (lot 2, 30/10/2026).
 *
 * Un élément de rapprochement OUVERT bloque :
 *  · `GLOBAL` — tous les versements (risque sur le wallet lui-même) ;
 *  · `VENDOR` — les versements de ce vendeur seulement.
 *
 * Fonction et non service : `RestaurantPayoutService` la lit avec son propre
 * client Prisma, sans dépendance de module à module. Sans élément ouvert — le
 * cas de la production tant qu'aucun rapprochement n'a été importé — elle ne
 * bloque rien.
 */
export interface ReconciliationPayoutBlock {
  scope: 'GLOBAL' | 'VENDOR';
  openItems: number;
  /** Un exemple d'écart, pour orienter l'administrateur. */
  sampleType: string;
}

type Reader = Pick<Prisma.TransactionClient, 'reconciliationItem'>;

export async function reconciliationPayoutBlock(
  db: Reader,
  restaurantId: string,
): Promise<ReconciliationPayoutBlock | null> {
  const open = await db.reconciliationItem.findMany({
    where: {
      status: 'OPEN',
      OR: [{ blockScope: 'GLOBAL' }, { blockScope: 'VENDOR', restaurantId }],
    },
    select: { blockScope: true, type: true },
    orderBy: { firstSeenAt: 'asc' },
    take: 50,
  });
  if (open.length === 0) return null;
  const global = open.find((i) => i.blockScope === 'GLOBAL');
  return {
    scope: global ? 'GLOBAL' : 'VENDOR',
    openItems: open.length,
    sampleType: (global ?? open[0]).type,
  };
}

export function reconciliationBlockMessage(
  block: ReconciliationPayoutBlock,
): string {
  return block.scope === 'GLOBAL'
    ? `Versements suspendus : ${block.openItems} écart(s) de rapprochement bloquant(s) sur le compte prestataire (ex. ${block.sampleType}). Résolvez-les dans Finance › Rapprochement.`
    : `Versements de ce vendeur suspendus : ${block.openItems} écart(s) de rapprochement ouvert(s) le concernant (ex. ${block.sampleType}). Résolvez-les dans Finance › Rapprochement.`;
}
