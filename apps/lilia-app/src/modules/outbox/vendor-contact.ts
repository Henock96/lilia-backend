import { cleanCongoMobilePhone } from '../../common/validation/congo-phone.decorator';

/**
 * Numéro à qui envoyer le SMS de secours d'une commande payée (audit du
 * 28/10/2026, F-02).
 *
 * L'escalade lisait `restaurant.owner.phone`, c'est-à-dire `User.phone`, qui
 * est **facultatif** — alors que `Restaurant.phone`, obligatoire, est le
 * numéro que la boutique affiche à ses clients. Un vendeur dont le compte
 * n'avait pas de téléphone n'était donc jamais escaladé : une ligne de log, et
 * la commande payée restait sans réponse.
 *
 * Ordre : le téléphone du compte d'abord (c'est la personne qui tient l'app),
 * puis celui de la boutique. Un numéro qui n'est pas un mobile congolais est
 * écarté : Infobip le refuserait, et l'escalade serait consommée à vide.
 */
export type EscalationPhone = {
  phone: string;
  source: 'OWNER' | 'SHOP';
};

export function pickEscalationPhone(input: {
  ownerPhone: string | null | undefined;
  shopPhone: string | null | undefined;
}): EscalationPhone | null {
  const owner = cleanCongoMobilePhone(input.ownerPhone);
  if (owner) return { phone: owner, source: 'OWNER' };
  const shop = cleanCongoMobilePhone(input.shopPhone);
  if (shop) return { phone: shop, source: 'SHOP' };
  return null;
}

/** Délai avant SMS d'une commande payée sans échéance d'acceptation. */
export const ORDER_PAID_ESCALATION_MINUTES = 10;

/**
 * Premier rappel d'une commande payée : à l'échéance d'escalade.
 *
 * Partagé par le chemin rapide (`OrdersListener`, qui reporte l'obligation au
 * lieu de l'acquitter) et le dispatcher (qui décide de l'escalade) : deux
 * calculs séparés finiraient par diverger, et le rappel tomberait après
 * l'annulation automatique.
 *
 * - commande à échéance d'acceptation (F3-01) : `échéance − leadMinutes` ;
 * - sinon : `paiement + ORDER_PAID_ESCALATION_MINUTES`.
 */
export function orderPaidReminderAt(input: {
  paidAt: Date;
  acceptDeadlineAt: Date | null;
  leadMinutes: number;
}): Date {
  if (input.acceptDeadlineAt) {
    return new Date(
      input.acceptDeadlineAt.getTime() - input.leadMinutes * 60_000,
    );
  }
  return new Date(
    input.paidAt.getTime() + ORDER_PAID_ESCALATION_MINUTES * 60_000,
  );
}
