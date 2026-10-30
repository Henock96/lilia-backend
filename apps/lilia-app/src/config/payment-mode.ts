import { ConfigService } from '@nestjs/config';

export const PAYMENT_MODES = [
  'MANUAL',
  'SANDBOX',
  'MTN_PRODUCTION',
  'PAWAPAY',
] as const;
export type PaymentModeValue = (typeof PAYMENT_MODES)[number];

/**
 * Lecture **unique** du mode de paiement (audit du 28/10/2026, F-11).
 *
 * Quatre sites lisaient `PAYMENT_MODE` avec chacun son repli `'MANUAL'` : si
 * la variable manquait, chacun basculait en silence dans le mode où un
 * administrateur déclare lui-même les paiements. Le défaut ne vit plus que dans
 * `env.validation.ts`, et seulement hors environnement déployé ; ici, une
 * valeur absente ou inconnue est une erreur qui nomme la variable sans en
 * afficher le contenu.
 */
export function readPaymentMode(config: ConfigService): PaymentModeValue {
  const raw = config.get<string>('PAYMENT_MODE');
  if (!raw || !(PAYMENT_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      'PAYMENT_MODE absent ou invalide (attendu : ' +
        `${PAYMENT_MODES.join(', ')}). Aucun mode de paiement n'est supposé.`,
    );
  }
  return raw as PaymentModeValue;
}
