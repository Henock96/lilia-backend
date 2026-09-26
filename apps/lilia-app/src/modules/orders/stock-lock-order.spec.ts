import { StockService } from './stock.service';

/**
 * Ordre de verrouillage déterministe (fix S-7, audit du 05/09/2026), tel que
 * F3-10 le réalise.
 *
 * ### Le défaut d'origine
 *
 * Chaque écriture de stock pose un verrou de ligne. Deux transactions qui
 * verrouillent les mêmes lignes **dans un ordre différent** s'interbloquent.
 * Deux causes se cumulaient : des identifiants non triés, et produits/menus
 * dépêchés en parallèle.
 *
 * ### Ce que F3-10 change, et ce que ce test vérifie
 *
 * La réservation prend désormais tous les verrous produits **d'un seul
 * `SELECT … ORDER BY id FOR UPDATE`**, sur des identifiants triés, puis ceux
 * des menus — toujours après. La restitution écrit produit par produit, ids
 * triés, puis les menus. Ce test capture la séquence réelle des requêtes et
 * vérifie cet ordre total. La preuve sous concurrence réelle (aucun
 * interblocage entre paniers croisés) est dans
 * `test/integration/stock-multi-units.int-spec.ts`.
 */
describe('StockService — ordre de verrouillage (S-7, F3-10)', () => {
  type Call = { sql: string; values: unknown[] };

  function buildTx(stock: Record<string, number | null>) {
    const calls: Call[] = [];
    const record = (strings: TemplateStringsArray, values: unknown[]) => {
      const sql = strings.join('?');
      calls.push({ sql, values });
      return sql;
    };
    const tx = {
      $queryRaw: jest.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = record(strings, values);
          const ids = values[0] as string[];
          if (sql.includes('FOR UPDATE')) {
            return ids.map((id) => ({
              id,
              nom: id,
              stockRestant: stock[id] ?? null,
            }));
          }
          if (sql.includes('RETURNING p.id')) {
            const units = values[1] as number[];
            return ids.map((id, i) => ({
              id,
              stockRestant: (stock[id] ?? 0) - units[i],
            }));
          }
          return [{ stockRestant: 1, before: 1 }];
        },
      ),
      $executeRaw: jest.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          record(strings, values);
          return 1;
        },
      ),
    };
    return { tx, calls };
  }

  const service = new StockService();
  const line = (productId: string, menuId: string | null = null) => ({
    productId,
    menuId,
    quantite: 1,
  });

  it('réservation : verrous produits triés en une requête, puis menus', async () => {
    const { tx, calls } = buildTx({
      'p-c': 10,
      'p-a': 10,
      'p-b': 10,
      'm-z': 5,
      'm-y': 5,
    });
    await service.decrementInTransaction(tx as never, [
      line('p-c'),
      line('p-a', 'm-z'),
      line('p-b', 'm-y'),
    ]);

    const locks = calls.filter((c) => c.sql.includes('FOR UPDATE'));
    expect(locks).toHaveLength(2);
    expect(locks[0].sql).toContain('"Product"');
    expect(locks[0].sql).toMatch(/ORDER BY id/);
    expect(locks[0].values[0]).toEqual(['p-a', 'p-b', 'p-c']);
    expect(locks[1].sql).toContain('"MenuDuJour"');
    expect(locks[1].values[0]).toEqual(['m-y', 'm-z']);

    // Toute écriture produit précède toute requête menu.
    const firstMenu = calls.findIndex((c) => c.sql.includes('"MenuDuJour"'));
    const lastProduct = calls
      .map((c) => c.sql.includes('"Product"'))
      .lastIndexOf(true);
    expect(lastProduct).toBeLessThan(firstMenu);
  });

  it('ordre d’entrée indifférent : même séquence de verrous', async () => {
    const a = buildTx({ p1: 5, p2: 5, p3: 5 });
    const b = buildTx({ p1: 5, p2: 5, p3: 5 });
    await service.decrementInTransaction(a.tx as never, [
      line('p3'),
      line('p1'),
      line('p2'),
    ]);
    await service.decrementInTransaction(b.tx as never, [
      line('p2'),
      line('p3'),
      line('p1'),
    ]);
    expect(a.calls[0].values[0]).toEqual(b.calls[0].values[0]);
  });

  it('restitution : produits triés un par un, puis menus', async () => {
    const { tx, calls } = buildTx({});
    await service.restoreInTransaction(tx as never, [
      { productId: 'p-c', menuId: 'm-z', quantite: 1, stockUnitsReserved: 1 },
      { productId: 'p-a', menuId: null, quantite: 2, stockUnitsReserved: 12 },
      { productId: 'p-b', menuId: 'm-y', quantite: 1, stockUnitsReserved: 1 },
    ]);
    const order = calls.map((c) =>
      c.sql.includes('"MenuDuJour"')
        ? `menu:${c.values.find((v) => typeof v === 'string' && v.startsWith('m'))}`
        : `product:${c.values.find((v) => typeof v === 'string' && v.startsWith('p'))}`,
    );
    expect(order).toEqual([
      'product:p-a',
      'product:p-b',
      'product:p-c',
      'menu:m-y',
      'menu:m-z',
    ]);
  });
});
