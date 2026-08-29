import { DynamicModule, Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';

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
type ModuleRef = Type<unknown> | DynamicModule;

interface MountedController {
  controller: string;
  viaModule: string;
}

/** `Reflect.getMetadata` n'accepte que des fonctions ou des objets. */
function isReflectable(target: unknown): target is object {
  return typeof target === 'function' || typeof target === 'object';
}

/** Nom lisible d'un module, qu'il soit statique ou dynamique. */
function moduleName(ref: ModuleRef): string {
  if (typeof ref === 'function') return ref.name;
  const target = (ref as DynamicModule).module;
  return typeof target === 'function' ? target.name : String(target);
}

/**
 * Parcourt le graphe d'imports en largeur et collecte tout controller déclaré.
 *
 * Les modules dynamiques (`ConfigModule.forRoot()`, `RedisModule.forRootAsync()`…)
 * portent leurs métadonnées sur l'objet retourné plutôt que sur la classe : les
 * deux formes sont donc lues.
 */
function collectControllers(root: ModuleRef): MountedController[] {
  const found: MountedController[] = [];
  const seen = new Set<unknown>();
  const queue: ModuleRef[] = [root];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = typeof current === 'function' ? current : current.module;
    if (seen.has(key)) continue;
    seen.add(key);

    const readMeta = <T>(metaKey: string): T[] => {
      const fromObject =
        typeof current === 'object'
          ? ((current as unknown as Record<string, T[]>)[metaKey] ?? [])
          : [];
      // `Reflect.getMetadata` lève sur une cible qui n'est ni fonction ni
      // objet — ce qui arrive dès qu'un import est un `forwardRef` ou une
      // promesse de module.
      const fromClass = isReflectable(key)
        ? ((Reflect.getMetadata(metaKey, key) as T[] | undefined) ?? [])
        : [];
      return [...fromClass, ...fromObject];
    };

    for (const controller of readMeta<Type<unknown>>(
      MODULE_METADATA.CONTROLLERS,
    )) {
      found.push({
        controller: controller.name,
        viaModule: moduleName(current),
      });
    }

    queue.push(...readMeta<ModuleRef>(MODULE_METADATA.IMPORTS));
  }

  return found;
}

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
