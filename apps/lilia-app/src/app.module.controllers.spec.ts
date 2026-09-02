import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { collectControllers } from '../test/module-graph';
import { AppModule } from './app.module';
import { CloudinaryController } from './modules/cloudinary/cloudinary.controller';

/**
 * Un controller qui n'est déclaré dans aucun module **n'existe pas** pour Nest :
 * ses routes ne sont jamais montées et les clients reçoivent le 404 par défaut
 * d'Express (« Cannot POST /upload/image?folder=restaurants »).
 *
 * C'est exactement ce qui est arrivé à `CloudinaryController` : le fichier a été
 * écrit, relu, sécurisé (`@Roles`, liste blanche de dossiers, throttle — fix H4
 * de l'audit du 28/08/2026) et documenté, mais `CloudinaryModule` ne déclarait
 * que `providers`. La route `POST /upload/image` n'a jamais été servie.
 *
 * Rien ne pouvait l'attraper : `tsc` ne connaît pas les controllers, le lint
 * voit un fichier exporté, et aucun test unitaire n'atteste qu'une route est
 * *montée*. D'où ce test, qui compare le disque au graphe de modules.
 *
 * Symétrique de `worker.module.spec.ts` : là-bas on interdit qu'un controller
 * entre dans un graphe, ici on exige qu'aucun n'en soit oublié.
 */

/** Les décorateurs `@Controller` vivent tous sous `modules/`. */
const MODULES_DIR = join(__dirname, 'modules');

/**
 * Controllers volontairement absents du graphe HTTP.
 *
 * ⚠️ Y ajouter une ligne revient à conserver du code mort : la bonne réponse
 * est presque toujours de supprimer le fichier ou de le déclarer.
 *
 * Les deux entrées ci-dessous ont été découvertes par ce test, au même titre
 * que `CloudinaryController`, mais leur situation diffère sur les deux points
 * qui comptent :
 *
 * 1. **Personne ne les appelle** — aucune occurrence de `admin/schedule` ni
 *    `admin/sms` dans les 5 dépôts. `/upload/image`, lui, a trois appelants.
 * 2. **Leurs modules sont dans le graphe du worker** (`AppScheduleModule` et
 *    `SmsModule`). Les y déclarer monterait deux routes ADMIN sur le port du
 *    worker, **sans authentification** — le worker n'a pas d'`APP_GUARD`.
 *    `worker.module.spec.ts` échouerait, et il aurait raison.
 *
 * Les monter demanderait donc de les déplacer dans un module servi uniquement
 * par le web (`AdminModule`). C'est une décision produit — « veut-on ces deux
 * boutons de maintenance ? » — pas une correction de bug, d'autant que le cron
 * d'horaires tourne désormais à la minute, ce qui vide `check-hours` de sa
 * raison d'être.
 */
const INTENTIONALLY_UNMOUNTED: string[] = [
  'ScheduleController', // POST /admin/schedule/{check-hours,reset-stock}
  'SmsController', // POST /admin/sms/test
];

/** Chemins des `*.controller.ts` présents sur le disque. */
function findControllerFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findControllerFiles(full));
    } else if (
      entry.name.endsWith('.controller.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Noms des classes portant `@Controller(...)` dans un fichier.
 *
 * Une lecture textuelle suffit et évite d'importer le fichier : certains
 * controllers tirent des modules entiers à l'import.
 */
function declaredControllerClasses(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const names: string[] = [];
  const pattern = /@Controller\([\s\S]*?\)[\s\S]*?export class (\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    names.push(match[1]);
  }
  return names;
}

describe('AppModule — controllers réellement montés', () => {
  const mounted = new Set(
    collectControllers(AppModule).map((m) => m.controller),
  );

  it('monte tous les controllers écrits sous modules/', () => {
    const orphans: string[] = [];

    for (const file of findControllerFiles(MODULES_DIR)) {
      for (const className of declaredControllerClasses(file)) {
        if (mounted.has(className)) continue;
        if (INTENTIONALLY_UNMOUNTED.includes(className)) continue;
        orphans.push(`${className} (${file.replace(`${__dirname}/`, '')})`);
      }
    }

    // Message explicite : on veut lire *quel* controller n'est déclaré nulle
    // part, pas un `expect(1).toBe(0)`.
    expect(orphans).toEqual([]);
  });

  it('monte POST /upload/image', () => {
    // Garde-fou nominatif : si le parcours du graphe cassait silencieusement,
    // le test précédent passerait sur un ensemble vide et ne protégerait plus
    // rien. Cette route est celle qui a réellement cassé — les deux fronts web
    // et l'admin Flutter en dépendent pour le logo vendeur.
    expect([...mounted]).toContain('CloudinaryController');

    // Et on vérifie le chemin, pas seulement la classe : renommer le préfixe
    // du controller casserait les appelants aussi sûrement que l'oublier.
    const prefix = Reflect.getMetadata(PATH_METADATA, CloudinaryController);
    const handler = CloudinaryController.prototype.uploadImage;
    expect(prefix).toBe('upload');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('image');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
  });
});
