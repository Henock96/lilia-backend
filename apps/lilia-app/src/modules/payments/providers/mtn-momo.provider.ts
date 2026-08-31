import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import {
  InitiateCollectionInput,
  InitiatePayoutInput,
  InitiateResult,
  PaymentProvider,
  ProviderTransactionStatus,
  ProviderUnavailableError,
} from './payment-provider.interface';
import { MtnMomoService } from '../services/mtn-momo.service';

/**
 * MTN MoMo Collections — enveloppe le `MtnMomoService` historique dans le
 * contrat commun.
 *
 * Ce rail n'a jamais tourné en production (il attend l'agrément MTN). Il est
 * conservé plutôt que supprimé : le code existe, il est testé, et il donne une
 * seconde option si la relation avec pawaPay tourne court. L'enveloppe est
 * mince — c'est le `MtnMomoService` d'origine qui fait le travail.
 *
 * ⚠️ Différence notable avec pawaPay : MTN génère le `X-Reference-Id` **côté
 * appelant** lui aussi, mais `requestToPay` en fabriquait un en interne. Le
 * contrat commun impose que l'identifiant soit fourni par `PaymentService` et
 * persisté avant l'appel — c'est ce qui rend le rejeu sûr. On lui passe donc le
 * nôtre.
 */
@Injectable()
export class MtnMomoProvider implements PaymentProvider {
  readonly name = 'MTN_MOMO' as const;
  readonly supportsCollection = true;
  /**
   * MTN propose bien une API de décaissement (Disbursements), mais elle exige
   * un agrément et un compte distincts que Lilia Food n'a pas. Déclarer le
   * reversement non supporté est la vérité — et évite un `PENDING` éternel.
   */
  readonly supportsPayout = false;

  private readonly logger = new Logger(MtnMomoProvider.name);

  constructor(private readonly mtn: MtnMomoService) {}

  async createCollection(
    input: InitiateCollectionInput,
  ): Promise<InitiateResult> {
    if (!this.mtn.validatePhoneNumber(input.phoneNumber)) {
      return {
        accepted: false,
        duplicate: false,
        failureCode: 'INVALID_PHONE_NUMBER',
        failureMessage: 'Numéro Mobile Money invalide.',
        raw: null,
      };
    }

    try {
      const referenceId = await this.mtn.requestToPay(
        {
          amount: String(input.amountXaf),
          currency: input.currency,
          externalId: input.paymentId,
          payer: {
            partyIdType: 'MSISDN',
            partyId: this.mtn.formatPhoneNumber(input.phoneNumber),
          },
          payerMessage: `Paiement commande ${input.orderRef}`,
          payeeNote: `Paiement chez ${input.vendorName}`,
        },
        input.providerTransactionId,
      );

      return {
        accepted: true,
        duplicate: false,
        raw: { referenceId },
      };
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response
        ?.status;
      // Un 4xx est un refus de la requête ; un 5xx ou une absence de réponse est
      // une panne, donc rejouable avec le même identifiant.
      if (status && status < 500) {
        return {
          accepted: false,
          duplicate: false,
          failureCode: 'PROVIDER_REJECTED',
          failureMessage:
            "L'opérateur a refusé la demande de paiement. Vérifiez le numéro.",
          raw: null,
        };
      }
      this.logger.error(
        `MTN requestToPay indisponible — statut ${status ?? 'n/a'}`,
      );
      throw new ProviderUnavailableError(
        "Le service de paiement de l'opérateur est momentanément indisponible.",
        status,
      );
    }
  }

  async getCollectionStatus(
    providerTransactionId: string,
  ): Promise<ProviderTransactionStatus | null> {
    const status = await this.mtn.getTransactionStatus(providerTransactionId);
    if (!status) return null;

    return {
      state:
        status.status === 'SUCCESSFUL'
          ? 'SUCCESS'
          : status.status === 'FAILED'
            ? 'FAILED'
            : 'PENDING',
      rawStatus: status.status,
      amountXaf: Number.isFinite(Number(status.amount))
        ? Math.round(Number(status.amount))
        : undefined,
      currency: status.currency,
      providerTransactionId: status.financialTransactionId,
      failureMessage: status.reason,
      raw: status,
    };
  }

  createPayout(_input: InitiatePayoutInput): Promise<InitiateResult> {
    return Promise.reject(
      new BadRequestException(
        'Le rail MTN MoMo Collections ne permet pas de reverser un vendeur. ' +
          'Basculez sur pawaPay pour activer les reversements automatiques.',
      ),
    );
  }

  getPayoutStatus(): Promise<ProviderTransactionStatus | null> {
    return Promise.resolve(null);
  }
}
