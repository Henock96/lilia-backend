import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * `Order.status` ne s'écrit qu'à un seul endroit.
 *
 * ## Pourquoi ce test lit le disque
 *
 * Sept sites répartis dans quatre fichiers écrivaient le statut d'une commande.
 * Six posaient un verrou optimiste correct ; le septième le posait et jetait son
 * résultat — un défaut d'intégrité que ni `tsc`, ni le lint, ni aucun test
 * unitaire ne pouvait voir, parce que chacun de ces sites, pris isolément, se
 * relit comme du code correct.
 *
 * Et aucun des sept n'écrivait dans `OrderHistory` : la table est restée vide
 * pendant cinq mois sans qu'une seule vérification ne s'en aperçoive.
 *
 * Centraliser ne suffit pas — il faut que la centralisation **tienne**. Le
 * huitième site sera écrit un jour par quelqu'un qui ne connaît pas cette
 * histoire, et il aura l'air parfaitement raisonnable. Ce test est ce qui le
 * fera échouer.
 *
 * Même approche que `app.module.controllers.spec.ts`, qui compare le disque au
 * graphe de modules pour la même raison : certaines propriétés ne sont pas
 * exprimables dans le type system.
 */

const SRC_DIR = join(__dirname, '..', '..');

/**
 * Le seul fichier autorisé à écrire `Order.status`.
 *
 * ⚠️ **Ajouter une ligne ici, c'est rouvrir le trou.** Un nouveau site
 * d'écriture doit passer par `OrderTransitionService` — c'est ce qui garantit
 * que sa transition sera historisée et son verrou vérifié. La seule raison
 * légitime de modifier cette liste est de renommer le service lui-même.
 */
const AUTHORIZED = ['modules/orders/order-transition.service.ts'];

/**
 * Motifs d'écriture Prisma sur la table `Order`.
 *
 * On cherche `…order.update…` / `…order.upsert…` suivi, dans les lignes qui
 * suivent, d'un `status:`. Les lectures (`findUnique`, `findMany`, `count`,
 * `groupBy`, `aggregate`) ne sont pas concernées, et les écritures qui ne
 * touchent pas au statut non plus — `deleteCommande`, par exemple, est un
 * soft-delete client parfaitement légitime.
 */
const WRITE_CALL =
  /\b(?:tx|prisma|this\.prisma)\.order\.(update|updateMany|upsert)\s*\(/;

/** Portée d'inspection : les ~15 lignes qui suivent l'appel. */
const LOOKAHEAD_LINES = 15;

interface WriteSite {
  file: string;
  line: number;
  snippet: string;
}

function collectTypeScriptFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTypeScriptFiles(full, found);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      found.push(full);
    }
  }
  return found;
}

function findStatusWrites(): WriteSite[] {
  const sites: WriteSite[] = [];

  for (const file of collectTypeScriptFiles(SRC_DIR)) {
    const relativePath = relative(SRC_DIR, file);
    if (AUTHORIZED.includes(relativePath)) continue;

    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!WRITE_CALL.test(line)) return;

      const window = lines.slice(index, index + LOOKAHEAD_LINES).join('\n');
      // `status:` dans le bloc `data` de l'écriture. Le `where: { status }` du
      // verrou optimiste, lui, est sur la ligne du `where` — on ne peut pas les
      // distinguer sans analyser l'AST, donc on accepte le faux positif : une
      // écriture conditionnée sur le statut *est* une écriture à surveiller.
      if (/\bstatus:\s*/.test(window)) {
        sites.push({
          file: relativePath,
          line: index + 1,
          snippet: line.trim(),
        });
      }
    });
  }

  return sites;
}

describe('Écriture de Order.status — couverture structurelle (P0-4)', () => {
  it('aucun fichier hors du service de transition n’écrit Order.status', () => {
    const sites = findStatusWrites();

    const report = sites
      .map((s) => `  · ${s.file}:${s.line}  ${s.snippet}`)
      .join('\n');

    expect(sites.length === 0 ? '' : report).toBe('');
  });

  it('le détecteur trouve réellement une écriture (garde anti-faux-négatif)', () => {
    // Un test de couverture qui ne détecte rien passe toujours. On vérifie donc
    // que le motif reconnaît bien la forme qu'il est censé interdire — sans
    // quoi une regex cassée rendrait ce fichier silencieusement inutile.
    const sample = [
      '      const claimed = await tx.order.updateMany({',
      '        where: { id: orderId, status: expectedStatus },',
      '        data: { status: newStatus },',
      '      });',
    ].join('\n');

    expect(WRITE_CALL.test(sample.split('\n')[0])).toBe(true);
    expect(/\bstatus:\s*/.test(sample)).toBe(true);
  });

  it('le service autorisé, lui, écrit bien le statut', () => {
    // Symétrique du précédent : si le service central cessait d'écrire le
    // statut, la centralisation serait vide de sens et le premier test
    // passerait pour de mauvaises raisons.
    const source = readFileSync(join(SRC_DIR, AUTHORIZED[0]), 'utf8');
    expect(WRITE_CALL.test(source)).toBe(true);
    expect(source).toContain('orderHistory.create');
  });
});
