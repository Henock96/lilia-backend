/* eslint-disable prettier/prettier */
/**
 * Garde-fou de régression sur le rate limiting des endpoints sensibles (LFD-6 / CRIT-7).
 *
 * `@Throttle({ <name>: { limit, ttl } })` pose des metadata Reflect sur la
 * méthode du controller, sous les clés `THROTTLER:LIMIT<name>` / `THROTTLER:TTL<name>`
 * (cf. @nestjs/throttler/dist/throttler.decorator). Ce test lit ces metadata
 * pour vérifier que les décorateurs ne sont pas retirés par accident.
 *
 * La vérification fonctionnelle réelle (réponse 429) se fait par test manuel
 * curl en staging — cf. Definition of Done de LIL-63.
 */
import { PromoController } from './promo.controller';
import { UsersController } from '../users/users.controller';
import { ReviewsController } from '../reviews/reviews.controller';
import { FavoritesController } from '../favorites/favorites.controller';

const LIMIT = 'THROTTLER:LIMIT';
const TTL = 'THROTTLER:TTL';

function throttle(method: object, name: string) {
  return {
    limit: Reflect.getMetadata(`${LIMIT}${name}`, method) as number | undefined,
    ttl: Reflect.getMetadata(`${TTL}${name}`, method) as number | undefined,
  };
}

describe('Rate limiting des endpoints sensibles (CRIT-7)', () => {
  it('POST /promo/validate : 1/s + 5/min (anti brute-force codes promo)', () => {
    const method = PromoController.prototype.validate;
    expect(throttle(method, 'short')).toEqual({ limit: 1, ttl: 1000 });
    expect(throttle(method, 'long')).toEqual({ limit: 5, ttl: 60000 });
  });

  it('POST /users/sync : 3/s burst + 20/min', () => {
    const method = UsersController.prototype.sync;
    expect(throttle(method, 'short')).toEqual({ limit: 3, ttl: 1000 });
    expect(throttle(method, 'long')).toEqual({ limit: 20, ttl: 60000 });
  });

  it('POST /reviews : 2/s + 5/min (anti faux avis)', () => {
    const method = ReviewsController.prototype.create;
    expect(throttle(method, 'short')).toEqual({ limit: 2, ttl: 1000 });
    expect(throttle(method, 'long')).toEqual({ limit: 5, ttl: 60000 });
  });

  it('POST /favorites/:restaurantId : 10/min', () => {
    const method = FavoritesController.prototype.addFavorite;
    expect(throttle(method, 'long')).toEqual({ limit: 10, ttl: 60000 });
  });
});
