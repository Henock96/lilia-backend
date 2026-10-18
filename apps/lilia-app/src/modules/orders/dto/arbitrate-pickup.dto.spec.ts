import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ArbitratePickupDto } from './arbitrate-pickup.dto';

/** 1B — un arbitrage dit toujours pourquoi : motif fermé, note pour `OTHER`. */
describe('ArbitratePickupDto', () => {
  const errorsFor = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(ArbitratePickupDto, body)).map(
      (e) => e.property,
    );

  it('motif connu sans note : valide', () => {
    expect(errorsFor({ reason: 'CUSTOMER_COLLECTED_NO_CODE' })).toEqual([]);
  });

  it('motif inconnu ou absent : refusé', () => {
    expect(errorsFor({ reason: 'PARCE_QUE' })).toContain('reason');
    expect(errorsFor({})).toContain('reason');
  });

  it('OTHER sans note : refusé (sinon l’arbitrage ne dit rien)', () => {
    expect(errorsFor({ reason: 'OTHER' })).toContain('note');
  });

  it('OTHER avec une note faite d’espaces : refusé (elle ne dit rien)', () => {
    expect(errorsFor({ reason: 'OTHER', note: '       ' })).toContain('note');
    expect(errorsFor({ reason: 'OTHER', note: '  ok   ' })).toContain('note');
  });

  it('OTHER avec une note trop courte : refusé ; avec une vraie note : valide', () => {
    expect(errorsFor({ reason: 'OTHER', note: 'ok' })).toContain('note');
    expect(
      errorsFor({ reason: 'OTHER', note: 'Client venu sans téléphone' }),
    ).toEqual([]);
  });

  it('note au-delà de 300 caractères : refusée', () => {
    expect(
      errorsFor({ reason: 'VENDOR_COULD_NOT_RECORD', note: 'x'.repeat(301) }),
    ).toContain('note');
  });
});
