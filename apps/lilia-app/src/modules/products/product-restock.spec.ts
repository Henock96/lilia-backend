import { ProductCommandService } from './product-command.service';

/**
 * Réapprovisionner doit remettre en vente (fix S-1).
 *
 * `stockRestant` est ce qui décide de la vente ; `stockQuotidien` n'est que la
 * capacité déclarée. `update()` n'écrivait que la seconde : un produit épuisé
 * dont le vendeur remontait le stock restait `stockRestant = 0`, donc
 * invendable — jusqu'au cron de 5 h, et **définitivement** pour un
 * `stockMode = PERMANENT` que ce cron ne touche pas.
 *
 * ⚠️ La contrepartie est le cas de la **ré-émission**. Les deux formulaires
 * produit renvoient `stockQuotidien` à chaque enregistrement : réaligner
 * inconditionnellement ferait ressusciter le stock déjà vendu dès qu'on
 * corrige une faute de frappe dans une description l'après-midi. Le
 * réalignement est donc conditionné au **changement réel** de la capacité, et
 * le geste « j'ai réassorti sans changer ma capacité » a sa propre route,
 * `PATCH /products/:id/stock`.
 */
describe('ProductCommandService.update — réalignement du stock', () => {
  function build(product: Record<string, unknown>) {
    const txUpdate = jest.fn().mockResolvedValue({ id: 'p1' });
    const prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          restaurantId: 'r1',
          productType: 'FOOD',
          availableFrom: null,
          availableUntil: null,
          restaurant: {
            vendorType: 'RESTAURANT',
            owner: { firebaseUid: 'fb-owner' },
          },
          ...product,
        }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'u', role: 'RESTAURATEUR' }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          product: {
            update: txUpdate,
            findUnique: jest.fn().mockResolvedValue({ id: 'p1', variants: [] }),
          },
          productVariant: {
            findMany: jest.fn().mockResolvedValue([]),
            createMany: jest.fn(),
            deleteMany: jest.fn(),
            update: jest.fn(),
          },
        }),
      ),
    };

    const service = new ProductCommandService(
      prisma as never,
      {
        assertProductTypeAllowed: jest.fn(),
        assertAvailabilityWindow: jest.fn(),
      } as never,
      { resolveTargetRestaurant: jest.fn() } as never,
      { record: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );
    return { service, txUpdate };
  }

  /** Ce que la transaction a réellement écrit sur la ligne `Product`. */
  const written = (txUpdate: jest.Mock) =>
    (txUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  it('remet stockRestant à niveau quand la capacité augmente', async () => {
    const { service, txUpdate } = build({
      stockQuotidien: 10,
      stockRestant: 0, // épuisé
    });

    await service.update('p1', { stockQuotidien: 30 }, 'fb-owner');

    expect(written(txUpdate)).toMatchObject({
      stockQuotidien: 30,
      stockRestant: 30,
    });
  });

  it('remet stockRestant à niveau quand la capacité baisse (invariant restant ≤ déclaré)', async () => {
    const { service, txUpdate } = build({
      stockQuotidien: 30,
      stockRestant: 25,
    });

    await service.update('p1', { stockQuotidien: 10 }, 'fb-owner');

    expect(written(txUpdate)).toMatchObject({
      stockQuotidien: 10,
      stockRestant: 10,
    });
  });

  it('repasse en illimité quand la capacité passe à null', async () => {
    const { service, txUpdate } = build({
      stockQuotidien: 10,
      stockRestant: 3,
    });

    await service.update('p1', { stockQuotidien: null }, 'fb-owner');

    expect(written(txUpdate)).toMatchObject({
      stockQuotidien: null,
      stockRestant: null,
    });
  });

  it('borne un produit illimité qu’on passe à stock fini', async () => {
    const { service, txUpdate } = build({
      stockQuotidien: null,
      stockRestant: null,
    });

    await service.update('p1', { stockQuotidien: 12 }, 'fb-owner');

    expect(written(txUpdate)).toMatchObject({
      stockQuotidien: 12,
      stockRestant: 12,
    });
  });

  it('NE touche PAS stockRestant quand la capacité est renvoyée inchangée', async () => {
    // Le cas de la ré-émission : le formulaire renvoie toujours le champ. Six
    // unités ont été vendues dans la journée ; corriger la description ne doit
    // pas les rendre.
    const { service, txUpdate } = build({
      stockQuotidien: 10,
      stockRestant: 4,
    });

    await service.update(
      'p1',
      { nom: 'Poulet braisé (grand)', stockQuotidien: 10 },
      'fb-owner',
    );

    expect(written(txUpdate)).not.toHaveProperty('stockRestant');
  });

  it('NE touche PAS stockRestant quand le champ est absent du corps', async () => {
    const { service, txUpdate } = build({
      stockQuotidien: 10,
      stockRestant: 4,
    });

    await service.update('p1', { nom: 'Nouveau nom' }, 'fb-owner');

    expect(written(txUpdate)).not.toHaveProperty('stockRestant');
  });
});
