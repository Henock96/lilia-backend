import { collectControllers } from '../../lilia-app/test/module-graph';
import { WorkerModule } from './worker.module';
import { WorkerController } from './worker.controller';

/**
 * Le worker ne doit monter **aucun controller métier**.
 *
 * Ce n'est pas une préférence d'architecture, c'est une frontière de sécurité.
 * Les `APP_GUARD` (`FirebaseAuthGuard`, `RolesGuard`, `ThrottlerGuard`) sont
 * déclarés dans `AppModule` / `AuthModule`, que le worker n'importe pas. Tout
 * controller qui entre dans son graphe est donc servi **sans authentification**
 * sur son port.
 *
 * Le graphe s'est déjà rempli deux fois par accident, sans que personne
 * l'écrive : `AppScheduleModule → OrdersModule` tirait `/orders`, `/refunds`,
 * `/tracking`… et `LoyaltyModule → PlatformSettingsModule` exposait
 * `PATCH /admin/platform-settings` — le pourcentage de frais de service,
 * modifiable par quiconque atteignait le port.
 *
 * Aucun de ces cas n'était visible au build : le compilateur ne connaît pas les
 * controllers, et le graphe se referme au démarrage. D'où ce test, qui parcourt
 * les métadonnées de module sans démarrer Nest — ni base, ni Redis, ni Firebase.
 *
 * ⚠️ En cas d'échec : **n'ajoutez pas le module fautif à la liste autorisée.**
 * Extrayez-en un module `*-core.module.ts` sans controller, comme
 * `OrdersCoreModule`, `NotificationsCoreModule`, `RefundsCoreModule` et
 * `PlatformSettingsCoreModule`.
 */
describe('WorkerModule — surface HTTP', () => {
  it("n'expose que le controller de santé du worker", () => {
    const mounted = collectControllers(WorkerModule);

    // Message explicite : en cas de régression, on veut lire *quel* module a
    // réintroduit *quel* controller, pas un simple `expect(2).toBe(1)`.
    const unexpected = mounted.filter(
      (m) => m.controller !== WorkerController.name,
    );

    expect(
      unexpected.map((m) => `${m.controller} (via ${m.viaModule})`),
    ).toEqual([]);
  });

  it('monte bien son propre controller de santé', () => {
    // Garde-fou du garde-fou : si le parcours du graphe cassait
    // silencieusement, le test précédent passerait sur une liste vide et ne
    // protégerait plus rien.
    const mounted = collectControllers(WorkerModule);

    expect(mounted.map((m) => m.controller)).toContain(WorkerController.name);
  });
});
