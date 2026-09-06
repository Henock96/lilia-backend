import { NotFoundException } from '@nestjs/common';

import { ProductQueryService } from './product-query.service';

/**
 * Vue détaillée d'un produit — `GET /products/:id`, la source de la fiche
 * produit du site client.
 *
 * Deux garanties, et elles ont la même racine : **la règle appartient au
 * serveur**.
 *
 * 1. La réponse porte `availableNow`, calculé par
 *    `isWithinAvailabilityWindow` — celui-là même que le checkout applique pour
 *    accepter ou refuser. Le site n'a donc pas à recopier la comparaison de
 *    bornes « HH:mm » dans le fuseau de Brazzaville. Deux implémentations de la
 *    même règle divergent en silence : c'est déjà arrivé sur les montants, où
 *    le client affichait 800 XAF de frais quand le serveur en facturait 1 500.
 * 2. Le vendeur inclus porte `isOpen` et `preorderLeadHours`. Sans le premier,
 *    la fiche proposait d'ajouter au panier d'une boutique fermée et le refus
 *    n'arrivait qu'au paiement. `findPopular`, `search` et `recommendations`
 *    sélectionnaient déjà `isOpen` : `findOne` était la seule des lectures
 *    publiques à ne pas le faire.
 */
describe('GET /products/:id — vue détaillée', () => {
  function build(product: unknown) {
    const findFirst = jest.fn().mockResolvedValue(product);
    const prisma = {
      product: {
        findFirst,
        fields: { availableFrom: 'F', availableUntil: 'U' },
      },
    };
    return {
      service: new ProductQueryService(prisma as never, {} as never),
      findFirst,
    };
  }

  const baseProduct = {
    id: 'p1',
    nom: 'Croissant',
    availableFrom: null as string | null,
    availableUntil: null as string | null,
    restaurant: {
      id: 'r1',
      nom: 'Boulangerie Lilia',
      isOpen: true,
      preorderLeadHours: 24,
    },
  };

  it('inclut isOpen et preorderLeadHours du vendeur', async () => {
    const { service, findFirst } = build(baseProduct);
    await service.findOne('p1');

    const select = findFirst.mock.calls[0][0].include.restaurant.select;
    expect(select).toMatchObject({
      id: true,
      nom: true,
      isOpen: true,
      preorderLeadHours: true,
    });
  });

  it('ne divulgue pas plus du vendeur que ces quatre champs', async () => {
    // Vue volontairement réduite : la fiche n'a pas besoin du téléphone du
    // vendeur, de son propriétaire ni de ses coordonnées GPS, et une route
    // publique n'expose que ce qu'elle doit.
    const { service, findFirst } = build(baseProduct);
    await service.findOne('p1');

    const select = findFirst.mock.calls[0][0].include.restaurant.select;
    expect(Object.keys(select).sort()).toEqual([
      'id',
      'isOpen',
      'nom',
      'preorderLeadHours',
    ]);
  });

  describe('availableNow', () => {
    it('vaut true sans fenêtre horaire — le cas de presque tout le catalogue', async () => {
      const { service } = build(baseProduct);
      const res = await service.findOne('p1');
      expect(res.data.availableNow).toBe(true);
    });

    it('vaut false hors de la fenêtre', async () => {
      // 03:00 à Brazzaville : la viennoiserie « 06:00 → 11:00 » n'est pas
      // vendable, et la fiche ne doit pas proposer de l'ajouter au panier.
      jest.useFakeTimers().setSystemTime(Date.UTC(2026, 8, 6, 2, 0));
      const { service } = build({
        ...baseProduct,
        availableFrom: '06:00',
        availableUntil: '11:00',
      });
      const res = await service.findOne('p1');
      expect(res.data.availableNow).toBe(false);
      jest.useRealTimers();
    });

    it('vaut true dans la fenêtre', async () => {
      jest.useFakeTimers().setSystemTime(Date.UTC(2026, 8, 6, 7, 30));
      const { service } = build({
        ...baseProduct,
        availableFrom: '06:00',
        availableUntil: '11:00',
      });
      const res = await service.findOne('p1');
      expect(res.data.availableNow).toBe(true);
      jest.useRealTimers();
    });

    it('gère une fenêtre à cheval sur minuit', async () => {
      // 01:00 à Brazzaville, fenêtre « 18:00 → 02:00 » : encore ouverte.
      jest.useFakeTimers().setSystemTime(Date.UTC(2026, 8, 6, 0, 0));
      const { service } = build({
        ...baseProduct,
        availableFrom: '18:00',
        availableUntil: '02:00',
      });
      const res = await service.findOne('p1');
      expect(res.data.availableNow).toBe(true);
      jest.useRealTimers();
    });
  });

  it('conserve les champs du produit', async () => {
    const { service } = build(baseProduct);
    const res = await service.findOne('p1');
    expect(res.data).toMatchObject({ id: 'p1', nom: 'Croissant' });
  });

  it('rejette un produit absent du catalogue public', async () => {
    const { service } = build(null);
    await expect(service.findOne('inconnu')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
