import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../src/modules/auth/decorators/public.decorator';

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

/**
 * Toutes les routes marquées `@Public()` (méthode ou contrôleur), lues sur
 * les métadonnées Nest — pas d'une liste tenue à la main. Clé :
 * `Contrôleur.méthode`, comme `admin-routes.ts`.
 */
export function collectPublicRoutes(): string[] {
  const keys: string[] = [];
  for (const file of controllerFiles(join(__dirname, '../src/modules'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, value) === undefined) continue;
      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, value) === true;
      const proto = (value as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined)
          continue;
        const isPublic =
          classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
        if (isPublic) keys.push(`${(value as { name: string }).name}.${name}`);
      }
    }
  }
  return keys.sort();
}
