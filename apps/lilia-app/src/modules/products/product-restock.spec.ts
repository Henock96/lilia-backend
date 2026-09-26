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
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
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
          $executeRaw: txExecuteRaw,
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
      {
        getSettings: async () => ({ multiUnitVariantsEnabled: true }),
      } as never, // PlatformSettingsService (F3-10)
    );
    return { service, txUpdate, txExecuteRaw };
  }

  /** Ce que la transaction a réellement écrit sur la ligne `Product`. */
  const written = (txUpdate: jest.Mock) =>
    (txUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  const quota = (stockQuotidien: number, stockRestant: number) => ({
    stockPolicy: 'DAILY_QUOTA',
    stockMode: 'DAILY',
    stockQuotidien,
    stockRestant,
  });

  it('quota du jour modifié : le reste suit l’écart, en SQL — les ventes du jour restent vendues', async () => {
    // F3-10 : avant, « reste = nouveau quota » ressuscitait ce qui avait été
    // vendu dans la journée (20 → 25 à midi avec 15 vendues donnait 25).
    const { service, txUpdate, txExecuteRaw } = build(quota(20, 5));

    await service.update('p1', { stockQuotidien: 25 }, 'fb-owner');

    expect(written(txUpdate)).not.toHaveProperty('stockRestant');
    const [strings, ...values] = txExecuteRaw.mock.calls[0];
    expect(strings.join('?')).toMatch(/GREATEST\(0, "stockRestant" \+/);
    expect(values).toContain(25);
  });

  it('repasse en « Toujours disponible » quand la capacité passe à null', async () => {
    const { service, txUpdate } = build(quota(10, 3));

    await service.update('p1', { stockQuotidien: null }, 'fb-owner');

    expect(written(txUpdate)).toMatchObject({
      stockPolicy: 'UNLIMITED',
      stockQuotidien: null,
      stockRestant: null,
    });
  });

  it('un produit illimité qui reçoit une quantité (ancien contrat, DAILY) devient « Quantité du jour »', async () => {
    const { service, txUpdate } = build({
      stockPolicy: 'UNLIMITED',
      stockMode: 'DAILY',
      stockQuotidien: null,
      stockRestant: null,
    });

    await service.update('p1', { stockQuotidien: 12 }, 'fb-owner');

    expect(written(txUpdate)).toMatchObject({
      stockPolicy: 'DAILY_QUOTA',
      stockMode: 'DAILY',
      stockQuotidien: 12,
      stockRestant: 12,
    });
  });

  it('stock réel : un nouveau niveau déclaré devient le restant (ancien contrat PERMANENT)', async () => {
    const { service, txUpdate } = build({
      stockPolicy: 'INVENTORY',
      stockMode: 'PERMANENT',
      stockQuotidien: 10,
      stockRestant: 0,
    });

    await service.update('p1', { stockQuotidien: 30 }, 'fb-owner');

    expect(written(txUpdate)).toMatchObject({
      stockQuotidien: 30,
      stockRestant: 30,
    });
  });

  it('changement de politique explicite : compteurs posés sur la nouvelle politique', async () => {
    const { service, txUpdate } = build(quota(10, 4));

    await service.update(
      'p1',
      { stockPolicy: 'INVENTORY', stockQuotidien: 60 },
      'fb-owner',
    );

    expect(written(txUpdate)).toMatchObject({
      stockPolicy: 'INVENTORY',
      stockMode: 'PERMANENT',
      stockRestant: 60,
    });
  });

  it('NE touche PAS stockRestant quand la capacité est renvoyée inchangée', async () => {
    // Le cas de la ré-émission : le formulaire renvoie toujours le champ. Six
    // unités ont été vendues dans la journée ; corriger la description ne doit
    // pas les rendre.
    const { service, txUpdate, txExecuteRaw } = build(quota(10, 4));

    await service.update(
      'p1',
      { nom: 'Poulet braisé (grand)', stockQuotidien: 10, stockMode: 'DAILY' },
      'fb-owner',
    );

    expect(written(txUpdate)).not.toHaveProperty('stockRestant');
    expect(txExecuteRaw).not.toHaveBeenCalled();
  });

  it('NE touche PAS stockRestant quand le champ est absent du corps', async () => {
    const { service, txUpdate } = build(quota(10, 4));

    await service.update('p1', { nom: 'Nouveau nom' }, 'fb-owner');

    expect(written(txUpdate)).not.toHaveProperty('stockRestant');
  });

  it('refuse une « Quantité du jour » sans quantité', async () => {
    const { service } = build({
      stockPolicy: 'UNLIMITED',
      stockMode: 'DAILY',
      stockQuotidien: null,
      stockRestant: null,
    });

    await expect(
      service.update('p1', { stockPolicy: 'DAILY_QUOTA' }, 'fb-owner'),
    ).rejects.toMatchObject({ response: { code: 'STOCK_UNITS_REQUIRED' } });
  });
});
