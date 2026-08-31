/**
 * Types de l'API pawaPay v2, transcrits depuis la documentation officielle
 * (https://docs.pawapay.io/v2/api-reference/). Rien n'est deviné ici : chaque
 * champ et chaque valeur d'énumération vient de la spécification.
 *
 * Références :
 *  · POST /v2/deposits          — initiate-deposit
 *  · GET  /v2/deposits/{id}     — check-deposit-status
 *  · POST /v2/payouts           — initiate-payout
 *  · GET  /v2/payouts/{id}      — check-payout-status
 *  · GET  /v2/active-conf       — active-configuration
 */

/** Réponse synchrone à une demande d'opération financière. */
export type PawaPayAcceptanceStatus =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'DUPLICATE_IGNORED';

/**
 * Statuts d'un dépôt (encaissement).
 * `COMPLETED` et `FAILED` sont les deux seuls états **terminaux**.
 */
export type PawaPayDepositStatus =
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'IN_RECONCILIATION'
  | 'COMPLETED'
  | 'FAILED';

/**
 * Statuts d'un reversement. Identiques à ceux d'un dépôt, plus `ENQUEUED`
 * (accepté mais mis en file d'attente).
 */
export type PawaPayPayoutStatus =
  | 'ACCEPTED'
  | 'ENQUEUED'
  | 'PROCESSING'
  | 'IN_RECONCILIATION'
  | 'COMPLETED'
  | 'FAILED';

export interface PawaPayFailureReason {
  failureCode: string;
  failureMessage?: string;
}

/**
 * Compte mobile money.
 *
 * ⚠️ La documentation officielle contient une coquille dans ses exemples de
 * réponse (`phoneNUmber`, N majuscule). Le parsing tolère les deux graphies —
 * on ne veut pas qu'une correction de leur côté, ou son absence, casse la
 * lecture d'un callback portant de l'argent.
 */
export interface PawaPayAccountDetails {
  phoneNumber?: string;
  phoneNUmber?: string;
  provider: string;
}

export interface PawaPayParty {
  type: 'MMO';
  accountDetails: PawaPayAccountDetails;
}

/** Corps de `POST /v2/deposits`. */
export interface PawaPayDepositRequest {
  /** UUIDv4, exactement 36 caractères. Clé d'idempotence côté pawaPay. */
  depositId: string;
  payer: PawaPayParty;
  /**
   * Montant en **chaîne**, motif `^([0]|([1-9][0-9]{0,17}))([.][0-9]{0,3}[1-9])?$`.
   * Pour le XAF, `decimalsInAmount: NONE` ⇒ entier sans partie décimale.
   */
  amount: string;
  /** ISO 4217, trois lettres majuscules. */
  currency: string;
  clientReferenceId?: string;
  /** 4 à 22 caractères, `^[a-zA-Z0-9 ]+$`. Visible par le client dans son SMS. */
  customerMessage?: string;
  /** Tableau d'objets à clé unique. `isPII` marque une donnée personnelle. */
  metadata?: Array<Record<string, string | boolean>>;
}

/** Corps de `POST /v2/payouts`. Symétrique du dépôt, `recipient` au lieu de `payer`. */
export interface PawaPayPayoutRequest {
  payoutId: string;
  recipient: PawaPayParty;
  amount: string;
  currency: string;
  clientReferenceId?: string;
  customerMessage?: string;
  metadata?: Array<Record<string, string | boolean>>;
}

/** Réponse de `POST /v2/deposits` et `POST /v2/payouts`. */
export interface PawaPayAcceptanceResponse {
  depositId?: string;
  payoutId?: string;
  status: PawaPayAcceptanceStatus;
  created?: string;
  failureReason?: PawaPayFailureReason;
}

/**
 * Objet transaction, tel qu'il apparaît dans `data` de la réponse de statut
 * **et** dans le corps d'un callback.
 *
 * Le callback porte `requestedAmount` en plus d'`amount` : le premier est ce
 * qu'on a demandé, le second ce qui a effectivement été mouvementé. On contrôle
 * `requestedAmount` en priorité, avec repli sur `amount`.
 */
export interface PawaPayTransaction {
  depositId?: string;
  payoutId?: string;
  status: PawaPayDepositStatus | PawaPayPayoutStatus;
  amount?: string;
  requestedAmount?: string;
  currency?: string;
  country?: string;
  payer?: PawaPayParty;
  recipient?: PawaPayParty;
  customerMessage?: string;
  clientReferenceId?: string;
  created?: string;
  providerTransactionId?: string;
  failureReason?: PawaPayFailureReason;
  /** En **lecture**, pawaPay renvoie un objet — alors que la requête prend un tableau. */
  metadata?: Record<string, string>;
}

/** Réponse de `GET /v2/deposits/{id}` et `GET /v2/payouts/{id}`. */
export interface PawaPaySearchResult {
  status: 'FOUND' | 'NOT_FOUND' | 'REJECTED';
  data?: PawaPayTransaction;
}

// ─── Configuration active (GET /v2/active-conf) ──────────────────────────────

export type PawaPayOperationType =
  | 'DEPOSIT'
  | 'PAYOUT'
  | 'REFUND'
  | 'REMITTANCE'
  | 'USSD_DEPOSIT'
  | 'NAME_LOOKUP';

export type PawaPayAvailability = 'OPERATIONAL' | 'DELAYED' | 'CLOSED';

export interface PawaPayActiveConf {
  merchantId?: string;
  merchantName?: string;
  countries?: Array<{
    country: string; // ISO alpha-3, ex. « COG »
    displayName?: Record<string, string>;
    prefix?: string;
    providers?: Array<{
      provider: string; // ex. « MTN_MOMO_COG »
      displayName?: string;
      logo?: string;
      currencies?: Array<{
        currency: string;
        displayName?: string;
        operationTypes?: Array<Record<string, unknown>>;
      }>;
    }>;
  }>;
}
