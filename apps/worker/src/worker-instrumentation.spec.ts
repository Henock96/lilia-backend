import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Les **deux** processus doivent initialiser Sentry, et l'initialiser en premier.
 *
 * ## Pourquoi ce test lit du texte plutôt que d'exécuter du code
 *
 * `Sentry.init()` est un effet de bord d'import. Sa présence ne se vérifie ni
 * par le type, ni par le graphe de modules, ni par un appel : elle tient à la
 * **position d'une ligne d'import**. C'est exactement le genre de propriété que
 * rien n'attrape — comme la déclaration d'un controller dans un module
 * (`app.module.controllers.spec.ts`) ou la liste des en-têtes CORS
 * (`cors-allowed-headers.spec.ts`), que ce dépôt fige déjà par des tests qui
 * comparent des sources.
 *
 * ## Ce que son absence coûtait (audit du 21/09/2026)
 *
 * `apps/worker/src/main.ts` n'importait pas `instrument`. Tous les
 * `Sentry.captureMessage` / `captureException` du code de fond y étaient donc
 * des **no-ops** :
 *
 *  · `payout.unknown_status` — « reversement introuvable chez le prestataire,
 *    vérification manuelle requise », c'est-à-dire le signal qui évite de payer
 *    un vendeur deux fois ;
 *  · `payment.reconciliation_timeout` — encaissement abandonné ;
 *  · `payment.resurrected` / `payment.mismatch` / `payout.mismatch` ;
 *  · toute exception non gérée dans l'un des neuf crons.
 *
 * Le défaut ne mordait pas tant que `RUN_BACKGROUND_JOBS` valait `true` sur le
 * web (processus instrumenté). Il se serait déclenché **au déploiement du
 * worker**, c'est-à-dire au moment précis où l'on croit améliorer la
 * robustesse — et sans rien casser de visible : les crons auraient continué de
 * tourner, simplement muets.
 *
 * ## Pourquoi « en premier » et pas seulement « présent »
 *
 * L'auto-instrumentation de Sentry patche `http`, `pg` et consorts **au
 * chargement**. Un import placé après `NestFactory` laisserait ces librairies
 * déjà résolues : Sentry s'initialiserait, et ne verrait rien.
 */
describe('Instrumentation Sentry des processus', () => {
  const firstImport = (relativePath: string): string => {
    const source = readFileSync(join(__dirname, relativePath), 'utf8');
    const line = source
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('import '));
    return line ?? '';
  };

  it.each([
    ['worker', './main.ts'],
    ['web', '../../lilia-app/src/main.ts'],
  ])(
    'le processus %s importe instrument en tout premier',
    (_name, relativePath) => {
      expect(firstImport(relativePath)).toMatch(/instrument';?$/);
    },
  );
});
