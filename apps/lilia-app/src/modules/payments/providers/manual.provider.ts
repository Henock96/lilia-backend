import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  InitiateCollectionInput,
  InitiatePayoutInput,
  InitiateResult,
  PaymentProvider,
  ProviderTransactionStatus,
} from './payment-provider.interface';

/**
 * Encaissement manuel — le mode qui a tourné en production jusqu'au
 * raccordement de pawaPay.
 *
 * Le client fait lui-même un transfert Mobile Money vers un numéro Lilia, et un
 * administrateur confirme la réception depuis l'application d'administration.
 * Il n'y a **aucun appel réseau** : le « provider » se contente de composer les
 * instructions à afficher.
 *
 * Conservé intact, et pas seulement par prudence : c'est le plan de repli si
 * pawaPay tombe ou si l'agrément tarde. Bascule par une variable
 * d'environnement, sans redéploiement de code.
 *
 * ⚠️ Extraction **verbatim** de `PaymentService.createManualPayment` — même
 * choix de numéro, mêmes libellés, même contenu de réponse. Un refactoring qui
 * change le comportement du chemin d'encaissement en production n'est pas un
 * refactoring.
 */
@Injectable()
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = 'MANUAL' as const;
  readonly supportsCollection = true;
  /**
   * Un reversement manuel se fait par virement depuis le téléphone d'un
   * administrateur, hors du système. Le déclarer non supporté fait échouer
   * proprement `POST /admin/orders/:id/payout` avec un message explicite,
   * plutôt que de créer une ligne `PENDING` que personne ne résoudra jamais.
   */
  readonly supportsPayout = false;

  private readonly logger = new Logger(ManualPaymentProvider.name);

  constructor(private readonly config: ConfigService) {}

  createCollection(input: InitiateCollectionInput): Promise<InitiateResult> {
    const isAirtel = input.method === 'AIRTEL_MONEY';
    // Le numéro d'encaissement dépend de l'opérateur choisi au checkout : on ne
    // peut pas demander à un client Airtel d'envoyer sur un numéro MTN.
    const paymentPhone = isAirtel
      ? this.config.get<string>('LILIA_AIRTEL_PAYMENT_PHONE', '') ||
        this.config.get<string>('LILIA_PAYMENT_PHONE', '')
      : this.config.get<string>('LILIA_PAYMENT_PHONE', '');
    const methodLabel = isAirtel ? 'Airtel Money' : 'MTN MoMo';

    if (!paymentPhone) {
      this.logger.error(
        `LILIA_PAYMENT_PHONE non configuré — paiement ${methodLabel} impossible`,
      );
      throw new BadRequestException(
        'Le paiement est temporairement indisponible. Contactez le support.',
      );
    }

    return Promise.resolve({
      accepted: true,
      duplicate: false,
      instructions: {
        message: `Envoyez ${input.amountXaf} FCFA au ${paymentPhone} (${methodLabel})`,
        reference: input.paymentId.slice(-8).toUpperCase(),
        phone: paymentPhone,
        method: input.method,
        methodLabel,
        amount: input.amountXaf,
        currency: input.currency,
        note: `Commande ${input.orderRef} - ${input.vendorName}`,
      },
      raw: { mode: 'manual', paymentPhone },
    });
  }

  /**
   * Aucun système externe à interroger : la vérité est la ligne en base, que
   * seul un administrateur fait avancer. Retourner `null` (« le prestataire ne
   * connaît pas cette transaction ») évite que l'appelant conclue quoi que ce
   * soit.
   */
  getCollectionStatus(): Promise<ProviderTransactionStatus | null> {
    return Promise.resolve(null);
  }

  createPayout(_input: InitiatePayoutInput): Promise<InitiateResult> {
    return Promise.reject(
      new BadRequestException(
        'Le mode de paiement manuel ne permet pas de reverser automatiquement ' +
          'un vendeur. Effectuez le virement depuis le compte Lilia Food, puis ' +
          'enregistrez-le manuellement.',
      ),
    );
  }

  getPayoutStatus(): Promise<ProviderTransactionStatus | null> {
    return Promise.resolve(null);
  }
}
