import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { VendorEarningsController } from './vendor-earnings.controller';

/**
 * « Mes gains » (F3-07) : réservé au vendeur, borné à ses boutiques par
 * l'identité de l'appelant — jamais par un identifiant venu de la requête.
 */
describe('VendorEarningsController', () => {
  it('GET /vendors/me/earnings, réservé au RESTAURATEUR', () => {
    expect(Reflect.getMetadata(PATH_METADATA, VendorEarningsController)).toBe(
      'vendors/me/earnings',
    );
    expect(Reflect.getMetadata(ROLES_KEY, VendorEarningsController)).toEqual([
      'RESTAURATEUR',
    ]);
    const handler = VendorEarningsController.prototype.mine;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
  });

  it('interroge le service avec l’identité de l’appelant', async () => {
    const earnings = { forOwner: jest.fn().mockResolvedValue({ data: {} }) };
    const controller = new VendorEarningsController(earnings as never);
    await controller.mine(
      { id: 'owner-1' } as never,
      { page: 2, limit: 10 } as never,
    );
    expect(earnings.forOwner).toHaveBeenCalledWith('owner-1', 2, 10);
  });
});
