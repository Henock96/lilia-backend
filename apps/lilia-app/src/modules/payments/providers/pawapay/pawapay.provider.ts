import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, PayoutProvider } from '@prisma/client';

import {
  InitiateCollectionInput,
  InitiatePayoutInput,
  InitiateResult,
  PaymentProvider,
  ProviderTransactionStatus,
  ProviderUnavailableError,
} from '../payment-provider.interface';
import { PawaPayHttpService } from './pawapay-http.service';
import {
  formatAmountForPawaPay,
  isValidCongoMsisdn,
  sanitizeCustomerMessage,
  toMsisdn,
  toProviderStatus,
} from './pawapay.mapper';
import {
  PawaPayAcceptanceResponse,
  PawaPayDepositRequest,
  PawaPayPayoutRequest,
  PawaPaySearchResult,
} from './pawapay.types';

/**
 * Provider pawaPay — encaissements (deposits) **et** reversements (payouts).
 *
 * Deux opérations, deux identifiants (`depositId` / `payoutId`), deux routes,
 * deux callbacks. Elles vivent dans la même classe parce qu'elles parlent au
 * même prestataire avec les mêmes conventions, mais rien ici ne les relie : le
 * provider ne sait pas qu'un reversement fait suite à un encaissement.
 *
 * ⚠️ Ce service **ne décide de rien**. Il ne lit ni n'écrit en base, n'émet
 * aucun événement et ne notifie personne. Il traduit une intention métier en
 * appel HTTP, et une réponse HTTP en état normalisé.
 */
@Injectable()
export class PawaPayProvider implements PaymentProvider {
  readonly name = 'PAWAPAY' as const;
  readonly supportsCollection = true;
  readonly supportsPayout = true;

  private readonly logger = new Logger(PawaPayProvider.name);

  constructor(
    private readonly http: PawaPayHttpService,
    private readonly config: ConfigService,
  ) {}

  // ─── Encaissement ───────────────────────────────────────────────────────────

  async createCollection(
    input: InitiateCollectionInput,
  ): Promise<InitiateResult> {
    const msisdn = toMsisdn(input.phoneNumber);
    if (!isValidCongoMsisdn(msisdn)) {
      // Refus métier, pas panne : inutile d'appeler pawaPay pour se faire
      // répondre INVALID_PHONE_NUMBER, et l'appel serait facturé.
      return {
        accepted: false,
        duplicate: false,
        failureCode: 'INVALID_PHONE_NUMBER',
        failureMessage: 'Numéro Mobile Money congolais invalide.',
        raw: null,
      };
    }

    const body: PawaPayDepositRequest = {
      depositId: input.providerTransactionId,
      payer: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: msisdn,
          provider: this.providerCodeForPayment(input.method),
        },
      },
      amount: formatAmountForPawaPay(input.amountXaf),
      currency: input.currency,
      clientReferenceId: input.paymentId,
      customerMessage: sanitizeCustomerMessage(
        `${this.statementPrefix()} ${input.orderRef}`,
      ),
      // Le tableau `metadata` est la forme attendue **en requête** (en lecture,
      // pawaPay renvoie un objet). Aucune donnée personnelle : `isPII` n'a donc
      // pas lieu d'être ici.
      metadata: [{ orderRef: input.orderRef }, { paymentId: input.paymentId }],
    };

    this.logger.log(
      `💰 pawaPay deposit — ${input.amountXaf} ${input.currency}, ref ${input.orderRef}`,
    );

    const { status, data } = await this.http.post<PawaPayAcceptanceResponse>(
      '/v2/deposits',
      body,
    );

    return this.toInitiateResult(status, data, 'deposit');
  }

  async getCollectionStatus(
    depositId: string,
  ): Promise<ProviderTransactionStatus | null> {
    const { status, data } = await this.http.get<PawaPaySearchResult>(
      `/v2/deposits/${encodeURIComponent(depositId)}`,
    );

    if (status === 404 || data?.status === 'NOT_FOUND') return null;
    if (data?.status !== 'FOUND' || !data.data) {
      // `REJECTED` ici signifie un refus d'authentification/autorisation sur la
      // consultation elle-même — pas un échec de la transaction. Conclure
      // « échec » serait faux, et ferait échouer un paiement peut-être abouti.
      throw new ProviderUnavailableError(
        'Consultation du statut refusée par le prestataire.',
        status,
      );
    }

    return toProviderStatus(data.data);
  }

  // ─── Reversement ────────────────────────────────────────────────────────────

  async createPayout(input: InitiatePayoutInput): Promise<InitiateResult> {
    const msisdn = toMsisdn(input.phoneNumber);
    if (!isValidCongoMsisdn(msisdn)) {
      return {
        accepted: false,
        duplicate: false,
        failureCode: 'INVALID_PHONE_NUMBER',
        failureMessage:
          'Le numéro Mobile Money de reversement du vendeur est invalide.',
        raw: null,
      };
    }

    const body: PawaPayPayoutRequest = {
      payoutId: input.providerPayoutId,
      recipient: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: msisdn,
          provider: this.providerCodeForPayout(input.payoutProvider),
        },
      },
      amount: formatAmountForPawaPay(input.amountXaf),
      currency: input.currency,
      clientReferenceId: input.payoutId,
      customerMessage: sanitizeCustomerMessage(
        `${this.statementPrefix()} ${input.orderRef}`,
      ),
      metadata: [{ orderRef: input.orderRef }, { payoutId: input.payoutId }],
    };

    this.logger.log(
      `💸 pawaPay payout — ${input.amountXaf} ${input.currency}, commande ${input.orderRef}`,
    );

    const { status, data } = await this.http.post<PawaPayAcceptanceResponse>(
      '/v2/payouts',
      body,
    );

    return this.toInitiateResult(status, data, 'payout');
  }

  async getPayoutStatus(
    payoutId: string,
  ): Promise<ProviderTransactionStatus | null> {
    const { status, data } = await this.http.get<PawaPaySearchResult>(
      `/v2/payouts/${encodeURIComponent(payoutId)}`,
    );

    if (status === 404 || data?.status === 'NOT_FOUND') return null;
    if (data?.status !== 'FOUND' || !data.data) {
      throw new ProviderUnavailableError(
        'Consultation du statut de reversement refusée par le prestataire.',
        status,
      );
    }

    return toProviderStatus(data.data);
  }

  // ─── Interne ────────────────────────────────────────────────────────────────

  /**
   * Traduit la réponse synchrone de pawaPay.
   *
   * Trois issues documentées :
   *  · `ACCEPTED`          — pris en charge, le résultat viendra par callback ;
   *  · `DUPLICATE_IGNORED` — on rejoue un identifiant déjà accepté. **Ce n'est
   *    pas une erreur** : c'est précisément ce qui protège du double débit
   *    quand le client réessaie. On le traite comme une acceptation ;
   *  · `REJECTED`          — refus définitif, `failureReason` en donne la cause.
   */
  private toInitiateResult(
    httpStatus: number,
    data: PawaPayAcceptanceResponse | undefined,
    kind: 'deposit' | 'payout',
  ): InitiateResult {
    if (!data?.status) {
      throw new ProviderUnavailableError(
        `Réponse ${kind} inexploitable du prestataire.`,
        httpStatus,
      );
    }

    if (data.status === 'ACCEPTED' || data.status === 'DUPLICATE_IGNORED') {
      return {
        accepted: true,
        duplicate: data.status === 'DUPLICATE_IGNORED',
        raw: data,
      };
    }

    this.logger.warn(
      `pawaPay ${kind} REJECTED — code ${data.failureReason?.failureCode ?? 'n/a'}`,
    );
    return {
      accepted: false,
      duplicate: false,
      failureCode: data.failureReason?.failureCode ?? 'REJECTED',
      failureMessage: data.failureReason?.failureMessage,
      raw: data,
    };
  }

  /**
   * Code opérateur pawaPay pour un encaissement.
   *
   * Ces codes (`MTN_MOMO_COG`, `AIRTEL_COG`) sont propres au compte marchand et
   * ne figurent dans **aucune énumération publique** de la documentation : ils
   * viennent de `GET /v2/active-conf`. On les rend donc configurables, avec un
   * défaut suivant la convention `<OPERATEUR>_<ISO3>` observée sur les autres
   * marchés — et `GET /payments/providers` expose la configuration réelle pour
   * lever le doute sans redéployer.
   */
  private providerCodeForPayment(method: PaymentMethod): string {
    return method === 'AIRTEL_MONEY'
      ? this.config.get<string>('PAWAPAY_AIRTEL_PROVIDER', 'AIRTEL_COG')
      : this.config.get<string>('PAWAPAY_MTN_PROVIDER', 'MTN_MOMO_COG');
  }

  /** Même table de correspondance, côté bénéficiaire. */
  private providerCodeForPayout(provider: PayoutProvider): string {
    return provider === 'AIRTEL_MONEY'
      ? this.config.get<string>('PAWAPAY_AIRTEL_PROVIDER', 'AIRTEL_COG')
      : this.config.get<string>('PAWAPAY_MTN_PROVIDER', 'MTN_MOMO_COG');
  }

  /**
   * Préfixe du libellé lu par le client dans son SMS. Borné à 22 caractères
   * avec la référence de commande — d'où la brièveté imposée.
   */
  private statementPrefix(): string {
    return this.config.get<string>('PAWAPAY_STATEMENT_PREFIX', 'LiliaFood');
  }
}
