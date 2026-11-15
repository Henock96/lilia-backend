import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ArbitrateDeliveryDto } from './arbitrate-delivery.dto';

/** 15/11/2026 — clôturer une livraison dit pourquoi ; l'avoir reste borné. */
describe('ArbitrateDeliveryDto', () => {
  const errorsFor = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(ArbitrateDeliveryDto, body)).map(
      (e) => e.property,
    );

  it('motif connu, sans note ni avoir : valide', () => {
    expect(errorsFor({ reason: 'CUSTOMER_REFUSED' })).toEqual([]);
  });

  it('motif inconnu ou absent : refusé', () => {
    expect(errorsFor({ reason: 'PARCE_QUE' })).toContain('reason');
    expect(errorsFor({})).toContain('reason');
  });

  it('OTHER sans vraie note : refusé', () => {
    expect(errorsFor({ reason: 'OTHER' })).toContain('note');
    expect(errorsFor({ reason: 'OTHER', note: '      ' })).toContain('note');
    expect(
      errorsFor({ reason: 'OTHER', note: 'Client absent, colis déposé' }),
    ).toEqual([]);
  });

  it('avoir : entier entre 100 et 100 000 FCFA', () => {
    const base = { reason: 'CUSTOMER_REFUSED' };
    expect(errorsFor({ ...base, voucherAmountXaf: 2500 })).toEqual([]);
    expect(errorsFor({ ...base, voucherAmountXaf: 99 })).toContain(
      'voucherAmountXaf',
    );
    expect(errorsFor({ ...base, voucherAmountXaf: 100_001 })).toContain(
      'voucherAmountXaf',
    );
    expect(errorsFor({ ...base, voucherAmountXaf: 1500.5 })).toContain(
      'voucherAmountXaf',
    );
  });

  it('validité de l’avoir : 1 à 90 jours', () => {
    const base = { reason: 'CUSTOMER_REFUSED', voucherAmountXaf: 1000 };
    expect(errorsFor({ ...base, voucherExpiresInDays: 90 })).toEqual([]);
    expect(errorsFor({ ...base, voucherExpiresInDays: 0 })).toContain(
      'voucherExpiresInDays',
    );
    expect(errorsFor({ ...base, voucherExpiresInDays: 91 })).toContain(
      'voucherExpiresInDays',
    );
  });
});
