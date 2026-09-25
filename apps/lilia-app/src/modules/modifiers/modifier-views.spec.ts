import { withPublicModifiers } from './modifier-views';

/**
 * F3-09 — projection publique des options (carte, catalogue, fiche produit).
 */
describe('withPublicModifiers', () => {
  const product = {
    id: 'p1',
    nom: 'Poulet braisé',
    restaurantId: 'r1',
    modifierGroups: [
      {
        displayOrder: 0,
        group: {
          id: 'g1',
          restaurantId: 'r1',
          name: 'Accompagnement',
          minSelect: 1,
          maxSelect: 1,
          deletedAt: null,
          options: [
            {
              id: 'o1',
              name: 'Alloco',
              priceDeltaXaf: 500,
              maxQuantity: 1,
              isAvailable: false,
              deletedAt: null,
              displayOrder: 0,
            },
          ],
        },
      },
    ],
  };

  it('interrupteur éteint : aucune option servie — la carte d’avant F3-09', () => {
    const [p] = withPublicModifiers([product], false);
    expect(p.modifierGroups).toEqual([]);
    expect(p.modifiersUnavailableReason).toBeNull();
  });

  it('allumé : sélection explicite, rien d’interne ne sort', () => {
    const [p] = withPublicModifiers([product], true);
    expect(p.modifierGroups).toEqual([
      {
        id: 'g1',
        name: 'Accompagnement',
        minSelect: 1,
        maxSelect: 1,
        required: true,
        options: [
          {
            id: 'o1',
            name: 'Alloco',
            priceDeltaXaf: 500,
            maxQuantity: 1,
            isAvailable: false,
          },
        ],
      },
    ]);
    expect(JSON.stringify(p.modifierGroups)).not.toMatch(
      /deletedAt|restaurantId|displayOrder/,
    );
  });

  it('groupe obligatoire sans option vendable : produit indisponible, raison du serveur (Q5)', () => {
    const [p] = withPublicModifiers([product], true);
    expect(p.modifiersUnavailableReason).toMatch(
      /plus aucun choix pour « Accompagnement »/,
    );
  });
});
