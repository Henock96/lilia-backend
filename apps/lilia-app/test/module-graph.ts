import { DynamicModule, Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';

/**
 * Lecture du graphe de modules Nest **sans démarrer l'application** — ni base,
 * ni Redis, ni Firebase.
 *
 * Deux tests s'appuient dessus, dans les deux sens :
 * - `worker.module.spec.ts` vérifie qu'aucun controller métier n'entre dans le
 *   graphe du worker (frontière de sécurité : le worker n'a pas d'`APP_GUARD`) ;
 * - `app.module.controllers.spec.ts` vérifie l'inverse — que tout controller
 *   écrit dans `modules/` est bien déclaré quelque part.
 *
 * Ces deux propriétés sont invisibles pour `tsc` : le compilateur ne connaît
 * pas les controllers, et le graphe ne se referme qu'au démarrage.
 */
export type ModuleRef = Type<unknown> | DynamicModule;

export interface MountedController {
  controller: string;
  viaModule: string;
}

/** `Reflect.getMetadata` n'accepte que des fonctions ou des objets. */
function isReflectable(target: unknown): target is object {
  return typeof target === 'function' || typeof target === 'object';
}

/** Nom lisible d'un module, qu'il soit statique ou dynamique. */
export function moduleName(ref: ModuleRef): string {
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
export function collectControllers(root: ModuleRef): MountedController[] {
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
