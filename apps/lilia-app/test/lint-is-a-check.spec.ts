import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La CI doit **constater** l'état du dépôt, pas le corriger.
 *
 * ## Ce qui s'est passé
 *
 * `package.json` déclarait `"lint": "eslint … --fix"`, et
 * `.github/workflows/ci.yml` appelait `npm run lint -- --max-warnings=0`. La
 * commande réellement exécutée était donc :
 *
 * ```
 * eslint "{src,apps,libs,test}/**\/*.ts" --fix --max-warnings=0
 * ```
 *
 * `--fix` **réécrit les fichiers** puis ne rapporte que ce qui reste
 * incorrigible. Or l'essentiel de ce que cette configuration fait respecter est
 * du formatage (`prettier/prettier`), qui est entièrement corrigible : ces
 * erreurs étaient donc réparées dans le runner, jetées avec lui, et la CI
 * sortait en 0 sans jamais rien signaler.
 *
 * Mesuré le 17/09/2026 sur `test/integration/order-history.int-spec.ts`, qui
 * portait 4 erreurs `prettier/prettier` depuis plusieurs commits :
 *
 * ```
 * $ npm run lint -- --max-warnings=0
 * EXIT = 0              ← la CI passe au vert
 * md5 du fichier : c75037ba… → a687afa5…   ← il a pourtant été réécrit
 * ```
 *
 * Une sonde qui répare ce qu'elle est censée mesurer ne mesure rien. Le dépôt
 * pouvait accumuler indéfiniment des erreurs de style sans qu'aucun signal ne
 * parte — et le jour où l'une d'elles aurait été **incorrigible**, elle serait
 * apparue au milieu d'un diff de reformatage géant.
 *
 * ⚠️ Ce fichier n'a pas d'équivalent ailleurs : il ne teste pas du code, il
 * teste **l'outillage**. C'est le même geste que `app.module.controllers.spec.ts`
 * (le disque doit correspondre au graphe de modules) et que
 * `pagination-bounds.spec.ts` (les DTO doivent s'accorder entre eux) : rendre
 * exigible une propriété qu'aucun compilateur ne regarde.
 */
const ROOT = join(__dirname, '..', '..', '..');

function packageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe('`npm run lint` constate, il ne répare pas', () => {
  it('le script `lint` ne porte pas `--fix`', () => {
    const lint = packageScripts().lint;

    expect(lint).toBeDefined();
    expect(lint).not.toMatch(/--fix/);
  });

  it('un script séparé reste disponible pour corriger', () => {
    // Retirer `--fix` sans offrir d'alternative pousserait chacun à le
    // réintroduire dans `lint`. Le geste existe, il est juste nommé.
    expect(packageScripts()['lint:fix']).toMatch(/--fix/);
  });

  it('aucune étape de CI ne lance un lint qui répare', () => {
    // Lecture en texte, pas en YAML : `js-yaml` n'est ici qu'une dépendance
    // **transitive** (et sous `overrides`). Un test d'outillage qui casse au
    // prochain bump d'une dépendance qu'il ne déclare pas est pire qu'absent.
    const workflow = readFileSync(
      join(ROOT, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );

    const lintLines = workflow
      .split('\n')
      .filter((line) => line.includes('lint') && !line.trim().startsWith('#'));

    expect(lintLines.length).toBeGreaterThan(0);
    // Une étape qui appellerait `lint:fix`, ou `eslint --fix` en direct,
    // rouvrirait le trou par une autre porte.
    for (const line of lintLines) {
      expect(line).not.toMatch(/--fix/);
      expect(line).not.toMatch(/lint:fix/);
    }
  });
});
