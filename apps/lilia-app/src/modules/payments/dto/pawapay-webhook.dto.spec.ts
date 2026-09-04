// Les décorateurs de validation lisent leurs métadonnées au chargement du DTO.
// Nest l'importe dans son bootstrap ; ici, la suite est montée sans Nest.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  PawaPayCallbackDto,
  PAWAPAY_KNOWN_STATUSES,
} from './pawapay-webhook.dto';

/**
 * Validation du corps des callbacks pawaPay.
 *
 * Cette suite existe pour une raison précise : la validation d'un endpoint
 * `@Public()` s'exécute **avant** le handler. Tout ce qu'elle refuse disparaît
 * sans laisser la moindre trace — ni `PaymentEvent`, ni ligne de log. Un
 * callback refusé ici est un callback perdu, et c'est de l'argent.
 */
function validate(body: unknown) {
  // `whitelist: true` reproduit la `ValidationPipe` globale de `main.ts`.
  const dto = plainToInstance(PawaPayCallbackDto, body, {
    enableImplicitConversion: false,
  });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: false });
}

const deposit = (over: Record<string, unknown> = {}) => ({
  depositId: '1e2f3a4b-0000-0000-0000-000000000000',
  status: 'COMPLETED',
  amount: '6400',
  requestedAmount: '6400',
  currency: 'XAF',
  country: 'COG',
  ...over,
});

describe('PawaPayCallbackDto', () => {
  it('accepte un callback de dépôt nominal', () => {
    expect(validate(deposit())).toHaveLength(0);
  });

  it('accepte les statuts documentés', () => {
    for (const status of PAWAPAY_KNOWN_STATUSES) {
      expect(validate(deposit({ status }))).toHaveLength(0);
    }
  });

  it('accepte un statut INCONNU — il doit être reçu, pas refusé', () => {
    // Le cœur du correctif. Un `@IsIn` renvoyait ici une 400 : pawaPay rejouait
    // quinze minutes, abandonnait, et rien n'était écrit nulle part. Le statut
    // inconnu est désormais accepté puis traité comme non terminal par
    // `mapPawaPayState` — donc tracé, sans transition métier.
    expect(validate(deposit({ status: 'SOMETHING_NEW_IN_V3' }))).toHaveLength(
      0,
    );
  });

  it('refuse un statut absent — sans lui, rien n’est interprétable', () => {
    const errors = validate(deposit({ status: undefined }));
    expect(errors).not.toHaveLength(0);
    expect(errors[0].property).toBe('status');
  });

  it('refuse un statut qui n’est pas une chaîne', () => {
    expect(validate(deposit({ status: 42 }))).not.toHaveLength(0);
  });

  it('borne la longueur du statut', () => {
    expect(validate(deposit({ status: 'X'.repeat(65) }))).not.toHaveLength(0);
  });

  it('accepte un callback de reversement', () => {
    const errors = validate({
      payoutId: '1e2f3a4b-0000-0000-0000-000000000001',
      status: 'COMPLETED',
      amount: '4500',
      currency: 'XAF',
      recipient: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: '242061234567',
          provider: 'MTN_MOMO_COG',
        },
      },
    });
    expect(errors).toHaveLength(0);
  });

  it('accepte la graphie « phoneNUmber » de la doc pawaPay', () => {
    const errors = validate(
      deposit({
        payer: {
          type: 'MMO',
          accountDetails: { phoneNUmber: '242061234567' },
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepte un motif d’échec structuré', () => {
    const errors = validate(
      deposit({
        status: 'FAILED',
        failureReason: {
          failureCode: 'INSUFFICIENT_BALANCE',
          failureMessage: 'The customer does not have enough funds.',
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('tolère des champs inconnus sans échouer (forbidNonWhitelisted: false)', () => {
    // pawaPay peut enrichir son payload à tout moment. Un champ nouveau ne doit
    // pas faire perdre la confirmation d'un paiement.
    expect(validate(deposit({ champInconnuDeV3: 'peu importe' }))).toHaveLength(
      0,
    );
  });
});
