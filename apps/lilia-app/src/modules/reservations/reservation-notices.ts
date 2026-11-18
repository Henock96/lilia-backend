import { Prisma } from '@prisma/client';

import { RESERVATION_NOTICE_EVENT } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import { BRAZZAVILLE_UTC_OFFSET_MS } from '../vendors/vendor-opening.policy';

/**
 * Lot 4 — ce que l'outbox porte pour prévenir un client ou un restaurant.
 *
 * La charge utile est **complète** : le dépilage (souvent dans le worker, sans
 * contexte) n'a rien à relire en base pour écrire le message.
 */
export type ReservationNotice =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CANCELLED_BY_CLIENT'
  | 'CANCELLED_BY_VENDOR'
  | 'REASSIGNED'
  | 'NO_SHOW'
  | 'NO_SHOW_UNDONE'
  | 'REMINDER'
  // 4B-2 — le paiement de la précommande est reçu.
  | 'CONFIRMED'
  | 'PAID'
  | 'DAILY_SUMMARY';

export interface ReservationNoticePayload {
  notice: ReservationNotice;
  audience: 'CLIENT' | 'VENDOR';
  /** `User.id` du destinataire (client, ou propriétaire du restaurant). */
  recipientUserId: string;
  restaurantName: string;
  /** Absent pour le récapitulatif quotidien. */
  reservationId?: string;
  arrivalAt?: string;
  partySize?: number;
  /** Nom de la ressource — seulement quand le client doit le connaître (C5). */
  spaceLabel?: string | null;
  /** Expiration : la demande attendait-elle le vendeur ou le paiement ? */
  expiredFrom?: 'PENDING' | 'AWAITING_PAYMENT';
  /** Délai de paiement, à l'acceptation. */
  paymentDeadlineAt?: string;
  /** 4B-2 — montant réel à payer, figé à l'acceptation (XAF). */
  totalXaf?: number;
  /** 4B-2 — le sous-total réel diffère de l'indicatif de la demande (OD-04). */
  priceChanged?: boolean;
  /**
   * J5 — réservation payée annulée : montant du remboursement intégral dû
   * (XAF). Le message dit « en cours », jamais « remboursé » (OD-07).
   */
  refundXaf?: number;
  /** Récapitulatif : jour civil et nombre de réservations. */
  date?: string;
  count?: number;
}

export async function enqueueReservationNotice(
  tx: Prisma.TransactionClient,
  outbox: OutboxService,
  payload: ReservationNoticePayload,
  aggregateId = payload.reservationId ?? payload.recipientUserId,
): Promise<void> {
  await outbox.enqueueInTransaction(tx, {
    type: RESERVATION_NOTICE_EVENT,
    aggregateId,
    payload: payload as unknown as Prisma.InputJsonValue,
  });
}

const DAYS = [
  'dimanche',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
];

/** « mardi 20/10 à 12:30 », heure de Brazzaville. */
export function formatArrival(iso: string): string {
  const local = new Date(new Date(iso).getTime() + BRAZZAVILLE_UTC_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[local.getUTCDay()]} ${pad(local.getUTCDate())}/${pad(
    local.getUTCMonth() + 1,
  )} à ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** « 12:30 », heure de Brazzaville. */
function formatTime(iso: string): string {
  return formatArrival(iso).split(' à ')[1];
}

const people = (n?: number) => `${n ?? 0} personne${(n ?? 0) > 1 ? 's' : ''}`;

export function reservationNoticeText(p: ReservationNoticePayload): {
  title: string;
  body: string;
} {
  const when = p.arrivalAt ? formatArrival(p.arrivalAt) : '';
  switch (p.notice) {
    case 'REQUESTED':
      return {
        title: '🍽️ Nouvelle demande de réservation',
        body: `${people(p.partySize)}, ${when}, avec précommande. Répondez dans les 30 minutes.`,
      };
    case 'ACCEPTED':
      return {
        title: '✅ Le restaurant a accepté votre demande',
        body: `${p.restaurantName}, ${when}. Payez votre précommande${
          p.totalXaf !== undefined ? ` (${p.totalXaf} FCFA)` : ''
        } avant ${
          p.paymentDeadlineAt ? formatTime(p.paymentDeadlineAt) : 'l’échéance'
        } pour confirmer la table.${
          p.priceChanged ? ' Le montant a changé depuis votre demande.' : ''
        }`,
      };
    case 'DECLINED':
      return {
        title: 'Réservation refusée',
        body: `${p.restaurantName} ne peut pas vous recevoir ${when}. Essayez une autre heure.`,
      };
    case 'EXPIRED':
      if (p.audience === 'VENDOR') {
        return {
          title: '⏰ Demande de réservation perdue',
          body: `La demande pour ${people(p.partySize)}, ${when}, a expiré faute de réponse.`,
        };
      }
      return p.expiredFrom === 'AWAITING_PAYMENT'
        ? {
            title: 'Réservation non confirmée',
            body: `Le paiement n’a pas été reçu à temps : la table de ${p.restaurantName}, ${when}, est libérée.`,
          }
        : {
            title: 'Pas de réponse du restaurant',
            body: `${p.restaurantName} n’a pas répondu à votre demande pour ${when}. Rien ne vous a été débité.`,
          };
    case 'CANCELLED_BY_CLIENT':
      return {
        title: 'Réservation annulée par le client',
        body: `${people(p.partySize)}, ${when} : la table est libérée.${
          p.refundXaf !== undefined
            ? ' La précommande payée est annulée : ne la préparez pas.'
            : ''
        }`,
      };
    case 'CANCELLED_BY_VENDOR':
      return {
        title: 'Réservation annulée par le restaurant',
        body: `${p.restaurantName} a annulé votre réservation ${when}.${
          p.refundXaf !== undefined
            ? ` Votre remboursement de ${p.refundXaf} FCFA est en cours.`
            : ''
        }`,
      };
    case 'REASSIGNED':
      return {
        title: 'Votre table a changé',
        body: p.spaceLabel
          ? `${p.restaurantName}, ${when} : vous serez installés à « ${p.spaceLabel} ».`
          : `${p.restaurantName}, ${when} : le restaurant vous a attribué une autre table.`,
      };
    case 'NO_SHOW':
      return {
        title: 'Absence enregistrée',
        body: `${p.restaurantName} indique que vous n’êtes pas venu ${when}. Une erreur ? Contactez le support.`,
      };
    case 'NO_SHOW_UNDONE':
      return {
        title: 'Absence retirée',
        body: `${p.restaurantName} a retiré l’absence enregistrée pour ${when}.`,
      };
    case 'CONFIRMED':
      return {
        title: '✅ Table confirmée',
        body: `Paiement reçu : ${p.restaurantName} vous attend ${when}, ${people(p.partySize)}.`,
      };
    case 'PAID':
      return {
        title: '💳 Réservation payée',
        body: `${people(p.partySize)}, ${when} : la précommande est payée. Préparez-la pour l’arrivée.`,
      };
    case 'REMINDER':
      return {
        title: '⏰ Votre table vous attend',
        body: `${p.restaurantName}, ${when}, ${people(p.partySize)}. Montrez votre code à l’arrivée.`,
      };
    case 'DAILY_SUMMARY':
      return {
        title: '📋 Vos réservations du jour',
        body: `${p.count ?? 0} réservation${(p.count ?? 0) > 1 ? 's' : ''} aujourd’hui. Ouvrez l’app pour le détail.`,
      };
  }
}
