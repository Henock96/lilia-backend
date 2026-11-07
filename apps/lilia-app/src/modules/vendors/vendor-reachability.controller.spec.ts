import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { ApiResponseInterceptor } from '../../common/interceptors/api-response.interceptor';
import { AdminVendorReachabilityController } from './vendor-reachability.controller';
import type { VendorReachabilityService } from './vendor-reachability.service';

/**
 * Le service est couvert sur PostgreSQL réel ; ce qui manquait, c'est la forme
 * servie. Le contrôleur renvoyait `{ data, summary }` : `summary` n'étant pas
 * une clé d'enveloppe, l'intercepteur global emballait le tout une seconde
 * fois et l'admin web recevait un objet là où il lit une liste — la page
 * Joignabilité plantait sur `rows.filter`. On passe donc la sortie du
 * contrôleur dans le vrai intercepteur, comme en production.
 */
function served(payload: unknown) {
  const context = {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class Dummy {},
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(payload) };
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  } as unknown as Reflector;
  return firstValueFrom(
    new ApiResponseInterceptor(reflector).intercept(context, next),
  ) as Promise<Record<string, unknown>>;
}

describe('AdminVendorReachabilityController — forme servie', () => {
  const rows = [
    { restaurantId: 'r1', needsAction: true },
    { restaurantId: 'r2', needsAction: false },
    { restaurantId: 'r3', needsAction: true },
  ];
  const controller = new AdminVendorReachabilityController({
    list: jest.fn().mockResolvedValue(rows),
  } as unknown as VendorReachabilityService);

  it('sert la liste directement sous `data`, sans seconde enveloppe', async () => {
    const body = await served(await controller.list());
    expect(body.data).toEqual(rows);
  });

  it('range le décompte sous `meta`', async () => {
    const body = await served(await controller.list());
    expect(body.meta).toEqual({ total: 3, needsAction: 2 });
  });
});
