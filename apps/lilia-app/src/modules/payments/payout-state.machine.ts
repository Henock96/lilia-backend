import { BadRequestException, Injectable } from '@nestjs/common';
import { PayoutStatus } from '@prisma/client';

/**
 * Transitions autorisées d'un reversement vendeur.
 *
 * Volontairement pauvre. Un reversement n'a que trois issues, et les états
 * terminaux le sont **vraiment** :
 *
 * ```
 * PENDING → SUCCESS      argent reçu par le vendeur
 * PENDING → FAILED       refusé par le prestataire ou l'opérateur
 * PENDING → CANCELLED    abandonné par arbitrage administratif
 * ```
 *
 * Ce que la matrice interdit, et pourquoi :
 *
 *  · `SUCCESS → *` — l'argent est parti. Aucun statut ne le fera revenir, et
 *    prétendre le contraire dans le modèle inviterait à écrire du code qui
 *    « annule » un virement effectué. Une reprise d'argent, si elle est un jour
 *    possible, sera une **opération distincte** avec sa propre trace.
 *  · `FAILED → PENDING` — on ne réanime pas une tentative échouée. Un nouvel
 *    essai crée une **nouvelle** ligne, avec un nouvel identifiant prestataire :
 *    c'est ce qui garantit qu'on ne réutilise jamais un `payoutId` déjà consommé.
 *
 * Cette matrice double les `updateMany` conditionnés sur `PENDING` : la base
 * empêche la course, la matrice empêche le contresens métier.
 */
export const PAYOUT_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  PENDING: [PayoutStatus.SUCCESS, PayoutStatus.FAILED, PayoutStatus.CANCELLED],
  SUCCESS: [],
  FAILED: [],
  CANCELLED: [],
};

/** Un vendeur n'est payé que dans cet état, et dans aucun autre. */
export const PAYOUT_PAID_STATUS = PayoutStatus.SUCCESS;

/**
 * États d'un reversement qui **bloquent** une nouvelle tentative.
 *
 * `PENDING` : une opération est en cours chez le prestataire, en lancer une
 * seconde risquerait un double virement.
 * `SUCCESS` : le vendeur est payé.
 *
 * `FAILED` et `CANCELLED` n'y figurent pas : ce sont précisément les cas où
 * réessayer a un sens.
 */
export const PAYOUT_BLOCKING_STATUSES: PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.SUCCESS,
];

@Injectable()
export class PayoutStateMachine {
  canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
    return PAYOUT_TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(from: PayoutStatus, to: PayoutStatus): void {
    if (!this.canTransition(from, to)) {
      const allowed = PAYOUT_TRANSITIONS[from] ?? [];
      throw new BadRequestException(
        `Transition de reversement invalide : ${from} → ${to}. ` +
          `Depuis ${from}, seules ces transitions sont possibles : ` +
          `[${allowed.join(', ') || 'aucune'}].`,
      );
    }
  }
}
