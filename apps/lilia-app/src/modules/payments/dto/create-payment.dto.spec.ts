// Les décorateurs de validation lisent leurs métadonnées au chargement du DTO.
// Nest l'importe dans son bootstrap ; ici, la suite est montée sans Nest.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CreatePaymentDto } from './create-payment.dto';

/**
 * Numéro du payeur dans `POST /payments`.
 *
 * Le web et l'app Flutter envoient la saisie telle quelle, espaces compris —
 * c'est d'ailleurs le format qu'ils recommandent (`+242 06 XX XX XX XX`). Le
 * DTO refusait toute saisie espacée : la commande était créée, l'encaissement
 * ne démarrait pas (400), alors que `CreateOrderDto` acceptait le même numéro.
 */
function validate(body: Record<string, unknown>) {
  // `transform` est implicite ici : `plainToInstance` applique les
  // `@Transform`, comme la `ValidationPipe` globale (`transform: true`).
  const dto = plainToInstance(CreatePaymentDto, body);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  return { dto, errors };
}

const body = (phoneNumber: unknown) => ({
  orderId: 'cmorder000000',
  phoneNumber,
});

describe('CreatePaymentDto — phoneNumber', () => {
  it.each([
    ['+242 06 123 45 67', '+242061234567'],
    ['06 123 45 67', '061234567'],
    ['06-123-45-67', '061234567'],
    ['(06) 123.45.67', '061234567'],
    [' 05 123 45 67 ', '051234567'],
    ['+242 04 123 45 67', '+242041234567'],
  ])('accepte « %s » et le normalise en « %s »', (input, normalized) => {
    const { dto, errors } = validate(body(input));
    expect(errors).toHaveLength(0);
    expect(dto.phoneNumber).toBe(normalized);
  });

  it.each(['+242061234567', '242061234567', '061234567', '61234567'])(
    'laisse « %s » inchangé (forme déjà acceptée)',
    (input) => {
      const { dto, errors } = validate(body(input));
      expect(errors).toHaveLength(0);
      expect(dto.phoneNumber).toBe(input);
    },
  );

  it.each([
    ['opérateur inconnu', '07 123 45 67'],
    ['trop court', '06 123 45'],
    ['trop long', '06 123 45 678'],
    ['lettres', '06 ABC 45 67'],
    ['autre pays', '+33 6 12 34 56 78'],
  ])('refuse un numéro invalide (%s)', (_cas, input) => {
    const { errors } = validate(body(input));
    expect(errors.map((e) => e.property)).toContain('phoneNumber');
  });

  it('garde le message qui cite un exemple désormais accepté', () => {
    const { errors } = validate(body('07 123 45 67'));
    const messages = Object.values(errors[0].constraints ?? {});
    expect(messages).toContain(
      'Numéro de téléphone congolais invalide (ex : 06 123 45 67)',
    );
    // L'exemple du message doit lui-même passer.
    expect(validate(body('06 123 45 67')).errors).toHaveLength(0);
  });

  it.each([
    ['absent', undefined],
    ['vide', ''],
    ['espaces seuls', '   '],
    ['nombre', 61234567],
  ])('refuse un numéro %s', (_cas, input) => {
    const { errors } = validate(body(input));
    expect(errors.map((e) => e.property)).toContain('phoneNumber');
  });
});
