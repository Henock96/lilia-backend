import { PaymentMethod, PayoutProvider } from '@prisma/client';

/**
 * Contrat que doit remplir un prestataire de paiement.
 *
 * Volontairement étroit. Un provider **parle au prestataire, il ne décide de
 * rien** : ni transition de commande, ni événement, ni notification, ni
 * remboursement. Tout cela vit dans `PaymentService` / `RestaurantPayoutService`,
 * qui restent identiques quel que soit le prestataire branché dessous.
 *
 * C'est ce qui rend le remplacement possible : passer de pawaPay à un autre PSP
 * ne devrait toucher qu'un dossier.
 *
 * ⚠️ Aucune méthode ne prend de montant venant du client. Les montants sont
 * calculés par l'appelant (`order.total` pour un encaissement,
 * `grossAmount - commissionAmount` pour un reversement) et passés en entiers XAF.
 */

/** Nom du rail d'encaissement / de reversement. */
export type PaymentProviderName = 'MANUAL' | 'MTN_MOMO' | 'PAWAPAY';

/**
 * Instructions affichées au client — mode MANUAL uniquement, où l'encaissement
 * est un virement que le client effectue lui-même.
 */
export interface ManualPaymentInstructions {
  message: string;
  reference: string;
  phone: string;
  method: PaymentMethod;
  methodLabel: string;
  amount: number;
  currency: string;
  note?: string;
}

export interface InitiateCollectionInput {
  /** `Payment.id` — sert de `clientReferenceId` côté prestataire. */
  paymentId: string;
  /**
   * Identifiant de la transaction chez le prestataire, **généré par nous** et
   * persisté AVANT l'appel. C'est la clé d'idempotence : rejouer le même
   * identifiant renvoie `DUPLICATE_IGNORED`, jamais un second débit.
   */
  providerTransactionId: string;
  /** Montant dû, entier XAF. Vient toujours de `order.total`. */
  amountXaf: number;
  currency: string;
  /** MSISDN du payeur, chiffres uniquement, indicatif pays inclus. */
  phoneNumber: string;
  method: PaymentMethod;
  /** Référence courte de la commande, affichée au client. */
  orderRef: string;
  vendorName: string;
}

export interface InitiatePayoutInput {
  /** `RestaurantPayout.id`. */
  payoutId: string;
  /** `payoutId` pawaPay — généré par nous, distinct du `depositId`. */
  providerPayoutId: string;
  /** Montant NET revenant au vendeur, entier XAF, commission déjà déduite. */
  amountXaf: number;
  currency: string;
  /** MSISDN du bénéficiaire. */
  phoneNumber: string;
  payoutProvider: PayoutProvider;
  orderRef: string;
}

/**
 * Résultat d'une demande d'opération.
 *
 * `accepted: false` **n'est pas une erreur technique** : c'est un refus métier du
 * prestataire (numéro invalide, opérateur indisponible, wallet à sec). Les
 * pannes réseau, elles, lèvent une exception — la distinction compte, parce
 * qu'un refus est définitif tandis qu'une panne se rejoue.
 */
export interface InitiateResult {
  accepted: boolean;
  /** Le prestataire a reconnu un rejeu du même identifiant. */
  duplicate: boolean;
  failureCode?: string;
  failureMessage?: string;
  /** Instructions à afficher — MANUAL uniquement. */
  instructions?: ManualPaymentInstructions;
  /** Réponse brute, journalisée dans `PaymentEvent`. Jamais renvoyée au client. */
  raw: unknown;
}

/** État normalisé d'une transaction chez le prestataire. */
export interface ProviderTransactionStatus {
  /**
   * `PENDING` couvre tous les états non terminaux du prestataire
   * (`ACCEPTED`, `ENQUEUED`, `PROCESSING`, `IN_RECONCILIATION`).
   */
  state: 'PENDING' | 'SUCCESS' | 'FAILED';
  /** Statut brut, conservé tel quel pour le journal. */
  rawStatus: string;
  /** Montant annoncé par le prestataire, entier XAF — sert au contrôle anti-mismatch. */
  amountXaf?: number;
  currency?: string;
  providerTransactionId?: string;
  failureCode?: string;
  failureMessage?: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;

  /** Le prestataire sait-il encaisser (collection) ? */
  readonly supportsCollection: boolean;
  /** Le prestataire sait-il reverser (payout) ? */
  readonly supportsPayout: boolean;

  createCollection(input: InitiateCollectionInput): Promise<InitiateResult>;

  /**
   * Statut d'un encaissement. `null` = le prestataire ne connaît pas encore la
   * transaction (à distinguer d'un échec : on ne conclut rien).
   */
  getCollectionStatus(
    providerTransactionId: string,
  ): Promise<ProviderTransactionStatus | null>;

  createPayout(input: InitiatePayoutInput): Promise<InitiateResult>;

  getPayoutStatus(
    providerPayoutId: string,
  ): Promise<ProviderTransactionStatus | null>;
}

/**
 * Levée quand le prestataire est injoignable ou répond une erreur transitoire.
 *
 * Distincte d'un refus métier : sur cette exception, l'appelant **ne marque pas
 * la transaction en échec** — elle reste en attente et le rejeu est sûr, car il
 * repartira avec le même identifiant.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly providerStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
