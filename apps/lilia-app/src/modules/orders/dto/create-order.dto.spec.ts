// Les décorateurs de validation lisent leurs métadonnées au chargement du DTO.
// Nest l'importe dans son bootstrap ; ici, la suite est montée sans Nest.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PaymentMethod } from '@prisma/client';

import { CreateOrderDto } from './create-order.dto';

/**
 * `contactPhone` du checkout : comportement figé avant de partager sa règle
 * avec `CreatePaymentDto` (même normalisation, même regex, même message).
 */
function validate(contactPhone: unknown) {
  const dto = plainToInstance(CreateOrderDto, {
    paymentMethod: PaymentMethod.MTN_MOMO,
    contactPhone,
  });
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  return { dto, errors };
}

describe('CreateOrderDto — contactPhone', () => {
  it.each([
    ['+242 06 123 45 67', '+242061234567'],
    ['06 123 45 67', '061234567'],
    ['06-123-45-67', '061234567'],
    ['(06) 123.45.67', '061234567'],
    ['+242061234567', '+242061234567'],
    ['061234567', '061234567'],
  ])('accepte « %s » et le normalise en « %s »', (input, normalized) => {
    const { dto, errors } = validate(input);
    expect(errors).toHaveLength(0);
    expect(dto.contactPhone).toBe(normalized);
  });

  it('reste optionnel', () => {
    expect(validate(undefined).errors).toHaveLength(0);
  });

  it.each(['07 123 45 67', '06 123 45', '06 ABC 45 67', ''])(
    'refuse « %s »',
    (input) => {
      const { errors } = validate(input);
      expect(errors.map((e) => e.property)).toContain('contactPhone');
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        'Numéro de téléphone congolais invalide (ex : 06 123 45 67)',
      );
    },
  );
});
