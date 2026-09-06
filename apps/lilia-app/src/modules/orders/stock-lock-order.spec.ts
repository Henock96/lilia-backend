import { StockService } from './stock.service';

/**
 * Ordre de verrouillage déterministe (fix S-7, audit du 05/09/2026).
 *
 * ### Le défaut
 *
 * Chaque `UPDATE` de stock pose un verrou de ligne. Deux transactions qui
 * verrouillent les mêmes lignes **dans un ordre différent** s'interbloquent :
 * T1 tient A et attend B pendant que T2 tient B et attend A. PostgreSQL le
 * détecte et en avorte une — aucune corruption, mais un 500 au client à la
 * place de sa commande. Reproduit en laboratoire avant correction, avec deux
 * transactions psql verrouillant deux produits en sens inverse.
 *
 * Deux causes se cumulaient :
 *
 * 1. les identifiants venaient d'un `findMany` **sans `orderBy`** — PostgreSQL
 *    ne garantit alors aucun ordre, deux paniers identiques pouvaient les
 *    recevoir inversés ;
 * 2. produits et menus étaient dépêchés en **parallèle** (`Promise.all`), si
 *    bien que l'entrelacement entre les deux tables restait indéterminé même
 *    avec des identifiants triés de chaque côté.
 *
 * ### Ce que ce test vérifie
 *
 * Que les écritures sortent dans un ordre **total** et **stable** : produits
 * triés d'abord, menus triés ensuite, quel que soit l'ordre d'entrée. C'est la
 * seule propriété qui ferme le cycle — un ordre commun à toutes les
 * transactions ne peut pas se croiser.
 */
describe('StockService — ordre de verrouillage', () => {
  /**
   * `$executeRaw` est appelé en tag de gabarit : les fragments SQL arrivent en
   * premier argument, les valeurs interpolées en variadiques.
   *
   * L'identifiant n'est pas au même rang selon la requête — 2ᵉ valeur à la
   * décrémentation (`qty, id, qty`), 3ᵉ à la restauration (`qty, qty, id`). On
   * le reconnaît donc à son **type** plutôt qu'à sa position : les quantités
   * sont des nombres, les identifiants des chaînes. Se fier au rang rendrait
   * ce test faux à la première ligne de SQL ajoutée.
   */
  const idOf = (values: unknown[]) =>
    String(values.find((v) => typeof v === 'string'));

  const tableOf = (strings: TemplateStringsArray) =>
    strings.join('').includes('"MenuDuJour"') ? 'menu' : 'product';

  /** Capture la séquence réelle des `UPDATE`, table et identifiant. */
  function buildTx(rows: string[]) {
    const issued: string[] = [];
    const tx = {
      product: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            rows.filter((r) => r.startsWith('p')).map((id) => ({ id })),
          ),
      },
      menuDuJour: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            rows.filter((r) => r.startsWith('m')).map((id) => ({ id })),
          ),
      },
      $executeRaw: jest.fn(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          issued.push(`${tableOf(strings)}:${idOf(values)}`);
          return Promise.resolve(1);
        },
      ),
    };
    return { tx, issued };
  }

  const service = new StockService();

  const cartItems = (ids: string[]) =>
    ids.map((id) => ({
      productId: id.startsWith('p') ? id : 'p-carrier',
      menuId: id.startsWith('m') ? id : undefined,
      quantite: 1,
    }));

  it('verrouille les produits par identifiant croissant', async () => {
    // L'ordre d'ENTRÉE est volontairement inverse de l'ordre attendu.
    const { tx, issued } = buildTx(['p-c', 'p-a', 'p-b']);

    await service.decrementInTransaction(
      tx as never,
      cartItems(['p-c', 'p-a', 'p-b']),
    );

    expect(issued).toEqual(['product:p-a', 'product:p-b', 'product:p-c']);
  });

  it('verrouille toujours les produits AVANT les menus', async () => {
    // Le point que le seul tri ne réglait pas : sans ordre fixe entre les deux
    // tables, une transaction pouvait tenir un produit en attendant un menu
    // pendant que l'autre faisait l'inverse.
    const { tx, issued } = buildTx(['m-z', 'p-b', 'm-a', 'p-a']);

    await service.decrementInTransaction(tx as never, [
      { productId: 'p-b', menuId: 'm-z', quantite: 1 },
      { productId: 'p-a', menuId: 'm-a', quantite: 1 },
    ]);

    expect(issued).toEqual([
      'product:p-a',
      'product:p-b',
      'menu:m-a',
      'menu:m-z',
    ]);
  });

  it('rend le même ordre quelle que soit la permutation d’entrée', async () => {
    const permutations = [
      ['p-1', 'p-2', 'p-3'],
      ['p-3', 'p-2', 'p-1'],
      ['p-2', 'p-3', 'p-1'],
    ];
    const results: string[][] = [];

    for (const ids of permutations) {
      const { tx, issued } = buildTx(ids);
      await service.decrementInTransaction(tx as never, cartItems(ids));
      results.push(issued);
    }

    // C'est *l'invariance* qui ferme le cycle, pas l'ordre choisi.
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it('interrompt la séquence dès qu’une ligne manque de stock', async () => {
    const { tx, issued } = buildTx(['p-a', 'p-b', 'p-c']);
    // `p-b` n'a plus assez de stock : 0 ligne affectée.
    (tx.$executeRaw as jest.Mock).mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const id = idOf(values);
        issued.push(`${tableOf(strings)}:${id}`);
        return Promise.resolve(id === 'p-b' ? 0 : 1);
      },
    );

    await expect(
      service.decrementInTransaction(
        tx as never,
        cartItems(['p-a', 'p-b', 'p-c']),
      ),
    ).rejects.toThrow(/stock épuisé/i);

    // On s'arrête à la ligne fautive : la transaction est de toute façon
    // annulée, continuer ne ferait que prendre des verrous pour rien.
    expect(issued).toEqual(['product:p-a', 'product:p-b']);
  });

  it('applique la même discipline à la restauration', async () => {
    // La restauration prend exactement les mêmes verrous que la
    // décrémentation. Un ordre total ne vaut que s'il est le MÊME partout :
    // le poser d'un seul côté laisserait le cycle ouvert entre une annulation
    // et un checkout concurrents — le cas le plus fréquent.
    const { tx, issued } = buildTx([]);

    await service.restoreInTransaction(tx as never, [
      { productId: 'p-c', quantite: 1 },
      { productId: 'p-a', menuId: 'm-b', quantite: 1 },
      { productId: 'p-b', menuId: 'm-a', quantite: 1 },
    ]);

    expect(issued).toEqual([
      'product:p-a',
      'product:p-b',
      'product:p-c',
      'menu:m-a',
      'menu:m-b',
    ]);
  });
});
