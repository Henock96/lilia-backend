import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  PaymentProvider,
  PaymentProviderName,
} from './providers/payment-provider.interface';
import { ManualPaymentProvider } from './providers/manual.provider';
import { MtnMomoProvider } from './providers/mtn-momo.provider';
import { PawaPayProvider } from './providers/pawapay/pawapay.provider';

/**
 * Modes d'encaissement possibles, pilotés par `PAYMENT_MODE`.
 *
 * `SANDBOX` et `MTN_PRODUCTION` désignent le même rail (MTN MoMo Collections)
 * sur deux environnements ; la distinction est portée par `MTN_MOMO_BASE_URL`,
 * pas par le choix du provider.
 */
export enum PaymentMode {
  MANUAL = 'MANUAL',
  SANDBOX = 'SANDBOX',
  MTN_PRODUCTION = 'MTN_PRODUCTION',
  PAWAPAY = 'PAWAPAY',
}

/**
 * Résout le prestataire à utiliser.
 *
 * Un seul endroit décide, et il décide à partir d'une variable d'environnement :
 * basculer d'un rail à l'autre — y compris revenir au mode manuel en pleine
 * panne — ne demande pas de déploiement de code.
 *
 * Le registre expose aussi le provider par **nom**, pour les chemins qui
 * doivent parler au prestataire d'une transaction déjà créée : un encaissement
 * enregistré en `PAWAPAY` doit être réconcilié auprès de pawaPay, même si la
 * plateforme est repassée en `MANUAL` entre-temps. Résoudre par le mode courant
 * ferait mentir la réconciliation.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly logger = new Logger(PaymentProviderRegistry.name);
  private readonly mode: PaymentMode;
  private readonly byName: Map<PaymentProviderName, PaymentProvider>;

  constructor(
    config: ConfigService,
    manual: ManualPaymentProvider,
    mtn: MtnMomoProvider,
    pawapay: PawaPayProvider,
  ) {
    this.mode = config.get<PaymentMode>('PAYMENT_MODE', PaymentMode.MANUAL);
    this.byName = new Map<PaymentProviderName, PaymentProvider>([
      [manual.name, manual],
      [mtn.name, mtn],
      [pawapay.name, pawapay],
    ]);
    this.logger.log(`Mode de paiement : ${this.mode}`);
  }

  get currentMode(): PaymentMode {
    return this.mode;
  }

  /** Provider à utiliser pour une **nouvelle** transaction. */
  forNewTransaction(): PaymentProvider {
    switch (this.mode) {
      case PaymentMode.PAWAPAY:
        return this.byName.get('PAWAPAY')!;
      case PaymentMode.SANDBOX:
      case PaymentMode.MTN_PRODUCTION:
        return this.byName.get('MTN_MOMO')!;
      case PaymentMode.MANUAL:
        return this.byName.get('MANUAL')!;
      default:
        // Joi borne déjà `PAYMENT_MODE` aux quatre valeurs ; ce cas ne devrait
        // pas se produire. Échouer bruyamment vaut mieux qu'encaisser via un
        // rail indéterminé.
        throw new ServiceUnavailableException(
          `Mode de paiement inconnu : ${String(this.mode)}`,
        );
    }
  }

  /**
   * Provider d'une transaction **existante**, d'après le nom stocké sur la
   * ligne (`Payment.provider` / `RestaurantPayout.provider`).
   */
  forStoredProvider(name: string): PaymentProvider {
    const provider = this.byName.get(name as PaymentProviderName);
    if (!provider) {
      throw new ServiceUnavailableException(
        `Aucun prestataire enregistré sous le nom « ${name} ».`,
      );
    }
    return provider;
  }

  /** Provider capable de reverser un vendeur, ou `null` si le mode ne le permet pas. */
  forPayout(): PaymentProvider | null {
    const provider = this.forNewTransaction();
    return provider.supportsPayout ? provider : null;
  }
}
