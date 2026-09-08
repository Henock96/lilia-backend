import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import { HealthController } from './health.controller';
import {
  THROTTLER_LONG,
  THROTTLER_SHORT,
} from '../../common/throttler/throttler-names';

/**
 * Exemption de rate limiting sur les sondes de santé (P-04, 08/09/2026).
 *
 * Contexte : `ThrottlerGuard` coûte ~545 ms par requête en production — deux
 * `EVAL` en série vers un Redis managé hébergé dans une autre région que
 * l'instance applicative, à ~271 ms d'aller-retour (voir le rapport interne
 * `PHASE3_2026-09-08_p04_latence_backend.md`). `/health/live` est frappé
 * toutes les 30 s par UptimeRobot (LIL-36) pour un handler qui ne fait que
 * retourner un objet littéral : cette dépense est pure perte.
 *
 * Ce que ce test verrouille, et qui ne se voit pas à la relecture : le guard lit
 * `THROTTLER_SKIP + <nom du limiteur>`, pas une clé unique. Un `@SkipThrottle()`
 * nu écrit `THROTTLER:SKIPdefault`, clé que rien ne lit ici puisque nos deux
 * limiteurs sont nommés `short` et `long`. Le test assert donc les **noms
 * réels** : il échoue si quelqu'un « simplifie » en `@SkipThrottle()`.
 */
describe('HealthController — exemption de throttling (P-04)', () => {
  const skipFor = (handler: (...args: never[]) => unknown, name: string) =>
    Reflect.getMetadata(THROTTLER_SKIP + name, handler) as boolean | undefined;

  describe.each([
    ['live (liveness UptimeRobot)', HealthController.prototype.live],
    ['check (statut général)', HealthController.prototype.check],
    ['checkFirebase', HealthController.prototype.checkFirebase],
  ])('%s est exempté', (_label, handler) => {
    it('du limiteur "short"', () => {
      expect(skipFor(handler, THROTTLER_SHORT)).toBe(true);
    });

    it('du limiteur "long"', () => {
      expect(skipFor(handler, THROTTLER_LONG)).toBe(true);
    });
  });

  /**
   * `/health/ready` fait un vrai `SELECT 1` sur la base. L'exempter en ferait un
   * levier d'amplification base de données, gratuit et anonyme : une requête
   * HTTP triviale déclenche une requête SQL. Elle reste throttlée — la dépense
   * Redis y est le prix de la protection, pas du gaspillage.
   */
  it('ready reste throttlé (il touche la base)', () => {
    const handler = HealthController.prototype.ready;
    expect(skipFor(handler, THROTTLER_SHORT)).toBeUndefined();
    expect(skipFor(handler, THROTTLER_LONG)).toBeUndefined();
  });
});
