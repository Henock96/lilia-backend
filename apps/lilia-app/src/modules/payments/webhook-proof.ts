import {
  PaymentEventOutcome,
  PaymentEventSource,
  Prisma,
} from '@prisma/client';

/**
 * Ce qui prouve qu'un webhook pawaPay a fonctionné (audit du 28/10/2026, F-10).
 *
 * Le compteur « webhooks reçus » comptait toute ligne `source = WEBHOOK` :
 *  - les confirmations **manuelles** d'un administrateur, que
 *    `confirmManualPayment` enregistrait avec cette source ;
 *  - les callbacks **ignorés** (transaction inconnue — par exemple un appel du
 *    bac à sable vers la production) ;
 *  - les callbacks d'un autre prestataire.
 *
 * Un nombre non nul ne prouvait donc rien. Seuls comptent désormais les
 * callbacks **pawaPay** qui ont été **appliqués** ou **reconnus comme doublon
 * d'une transaction connue**. Même ainsi, ce compte prouve que la voie
 * fonctionne, pas que toutes les transactions sont justes : c'est le travail
 * du rapprochement.
 */
export const PROVEN_WEBHOOK_WHERE = {
  source: PaymentEventSource.WEBHOOK,
  provider: 'PAWAPAY',
  outcome: {
    in: [PaymentEventOutcome.APPLIED, PaymentEventOutcome.DUPLICATE],
  },
} satisfies Prisma.PaymentEventWhereInput;
