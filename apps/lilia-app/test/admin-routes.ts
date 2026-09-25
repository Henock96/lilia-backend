import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ROLES_KEY } from '../src/modules/auth/decorators/roles.decorator';
import { REQUIRE_CAPABILITY_KEY } from '../src/modules/auth/decorators/require-capability.decorator';

export interface AdminRoute {
  /** `Contrôleur.méthode` — clé stable de la table de classement. */
  key: string;
  capability: string | undefined;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

/**
 * Toutes les routes ouvertes au rôle ADMIN, lues sur les métadonnées Nest de
 * chaque contrôleur du dépôt — pas d'une liste tenue à la main.
 */
export function collectAdminRoutes(): AdminRoute[] {
  const routes: AdminRoute[] = [];
  for (const file of controllerFiles(join(__dirname, '../src/modules'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, value) === undefined) continue;
      const classRoles = Reflect.getMetadata(ROLES_KEY, value) as
        | string[]
        | undefined;
      const classCap = Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, value) as
        | string
        | undefined;
      const proto = (value as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined)
          continue;
        const roles =
          (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ??
          classRoles;
        if (!roles?.includes('ADMIN')) continue;
        routes.push({
          key: `${(value as { name: string }).name}.${name}`,
          capability:
            (Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler) as
              | string
              | undefined) ?? classCap,
        });
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}
