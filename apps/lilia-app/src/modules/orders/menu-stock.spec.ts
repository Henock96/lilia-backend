import { countMenus } from './menu-quantities';
import {
  OrderValidatorService,
  menuUnavailabilityReason,
} from './order-validator.service';

/**
 * F-01 / F-02 (Master Audit v1) — un menu est une unité de stock, et il doit
 * être encore achetable au moment où on le paie.
 *
 * Un menu de 3 plats mis au panier 2 fois = 3 lignes à `quantite = 2`. Le
 * validateur et la décrémentation additionnaient les 3 lignes : 6 menus
 * comptés pour 2 vendus.
 */

const menuLines = (menuId: string, q: number, products: string[]) =>
  products.map((productId, i) => ({
    id: `${menuId}-l${i}`,
    menuId,
    productId,
    quantite: q,
    product: { restaurantId: 'resto-1' },
  }));

describe('countMenus', () => {
  it('un menu de 3 plats commandé 2 fois vaut 2 menus, pas 6', () => {
    expect(countMenus(menuLines('m1', 2, ['a', 'b', 'c']))).toEqual(
      new Map([['m1', 2]]),
    );
  });

  it('ignore les lignes individuelles et sépare les menus', () => {
    const lines = [
      ...menuLines('m1', 1, ['a', 'b']),
      { menuId: null, productId: 'x', quantite: 5 },
      ...menuLines('m2', 3, ['c']),
    ];
    expect(countMenus(lines)).toEqual(
      new Map([
        ['m1', 1],
        ['m2', 3],
      ]),
    );
  });
});

// Les scénarios `StockService` de ce fichier (décrément et restitution d'un
// menu, F-01) vivent désormais dans `test/integration/stock-multi-units.int-spec.ts` :
// depuis F3-10 la réservation verrouille (`FOR UPDATE`) puis décrémente par lot
// (`unnest`), ce qu'une simulation en mémoire du SQL ne décrit plus fidèlement.
// Ils y tournent contre un vrai PostgreSQL.

describe('OrderValidatorService.validateStock — menus (F-01, F-02)', () => {
  const now = new Date();
  const menu = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'm1',
    nom: 'Menu midi',
    isActive: true,
    dateDebut: new Date(now.getTime() - 3_600_000),
    dateFin: new Date(now.getTime() + 3_600_000),
    restaurantId: 'resto-1',
    stockRestant: 2,
    products: [{ productId: 'a' }, { productId: 'b' }, { productId: 'c' }],
    ...over,
  });
  const product = (id: string) => ({
    id,
    nom: id,
    restaurantId: 'resto-1',
    isAvailable: true,
    deletedAt: null,
    stockRestant: null,
    availableFrom: null,
    availableUntil: null,
  });

  const build = (menuRow: unknown) => {
    const prisma = {
      product: { findMany: jest.fn(async () => ['a', 'b', 'c'].map(product)) },
      menuDuJour: { findMany: jest.fn(async () => (menuRow ? [menuRow] : [])) },
    };
    return new OrderValidatorService(prisma as never, {} as never, {} as never);
  };

  it('stock menu 2, 1 menu de 3 plats : accepté', async () => {
    await expect(
      build(menu()).validateStock(menuLines('m1', 1, ['a', 'b', 'c'])),
    ).resolves.toBeUndefined();
  });

  it('stock menu 2, 3 menus : refusé avec le reste réel', async () => {
    await expect(
      build(menu()).validateStock(menuLines('m1', 3, ['a', 'b', 'c'])),
    ).rejects.toThrow(/il ne reste que 2/);
  });

  it.each([
    ['désactivé après l’ajout', { isActive: false }, /n'est plus proposé/],
    [
      'fenêtre fermée',
      { dateFin: new Date(now.getTime() - 60_000) },
      /n'est plus disponible à cette heure/,
    ],
    [
      'pas encore ouvert',
      { dateDebut: new Date(now.getTime() + 60_000) },
      /n'est plus disponible à cette heure/,
    ],
    [
      'un produit retiré de la composition',
      { products: [{ productId: 'a' }, { productId: 'b' }] },
      /composition du menu/,
    ],
    [
      'un produit ajouté à la composition',
      {
        products: [
          { productId: 'a' },
          { productId: 'b' },
          { productId: 'c' },
          { productId: 'd' },
        ],
      },
      /composition du menu/,
    ],
    [
      'passé à un autre vendeur',
      { restaurantId: 'resto-2' },
      /n'appartient pas/,
    ],
  ])('menu %s → refusé au checkout', async (_label, over, message) => {
    await expect(
      build(menu(over)).validateStock(menuLines('m1', 1, ['a', 'b', 'c'])),
    ).rejects.toThrow(message);
  });

  it('menu supprimé entre-temps → refusé', async () => {
    await expect(
      build(null).validateStock(menuLines('m1', 1, ['a', 'b', 'c'])),
    ).rejects.toThrow(/retiré de la carte/);
  });

  it('menuUnavailabilityReason ne refuse pas un changement de prix (le prix est relu)', () => {
    expect(
      menuUnavailabilityReason(
        { ...menu(), prix: 9_999 } as never,
        [{ productId: 'a' }, { productId: 'b' }, { productId: 'c' }],
        'resto-1',
        now,
      ),
    ).toBeNull();
  });
});
