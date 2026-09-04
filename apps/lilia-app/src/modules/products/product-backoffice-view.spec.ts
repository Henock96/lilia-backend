import { ForbiddenException } from '@nestjs/common';

import { ProductQueryService } from './product-query.service';

/**
 * `GET /products/manage` — le catalogue **du gestionnaire**.
 *
 * Ces tests écrivent à la main ce que la vue back-office doit montrer de plus
 * que la vue client, et à qui. Les dériver du `where` construit par le service
 * ne prouverait rien : ils vérifieraient que le code sait se relire.
 *
 * Le défaut d'origine : les quatre back-offices lisaient `GET /products`, la
 * route publique. Un vendeur suspendu ne voyait plus son propre catalogue, et
 * un produit marqué indisponible disparaissait de l'écran qui porte le bouton
 * « remettre en vente ».
 */
describe('ProductQueryService.findAllForOwner — vue back-office', () => {
  const RESTO = 'resto-a';

  function build(
    resolve: jest.Mock = jest.fn().mockResolvedValue({
      id: RESTO,
      vendorType: 'RESTAURANT',
      onBehalfOf: false,
    }),
  ) {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = { product: { findMany, count } };
    const access = { resolveTargetRestaurant: resolve };
    const service = new ProductQueryService(prisma as never, access as never);
    return { service, findMany, count, resolve };
  }

  /** Le `where` réellement envoyé à Prisma pour la page demandée. */
  function whereOf(findMany: jest.Mock): Record<string, unknown> {
    return findMany.mock.calls[0][0].where as Record<string, unknown>;
  }

  it("n'applique aucun filtre de visibilité vendeur", async () => {
    const { service, findMany } = build();
    await service.findAllForOwner('fb-owner');

    const where = whereOf(findMany);
    // La présence d'une contrainte sur `restaurant` signifierait que la vue
    // gestionnaire hérite de la frontière marketplace — c'est exactement ce qui
    // rendait un vendeur suspendu aveugle sur sa propre boutique.
    expect(where.restaurant).toBeUndefined();
    expect(where.restaurantId).toBe(RESTO);
  });

  it('montre les produits marqués indisponibles', async () => {
    const { service, findMany } = build();
    await service.findAllForOwner('fb-owner');

    // `isAvailable: true` ici rendrait le produit indisponible irrécupérable :
    // le seul écran d'où on le réactive ne l'afficherait plus.
    expect(whereOf(findMany).isAvailable).toBeUndefined();
  });

  it('montre les produits hors de leur fenêtre horaire', async () => {
    const { service, findMany } = build();
    await service.findAllForOwner('fb-owner');

    const where = whereOf(findMany);
    expect(where.availableFrom).toBeUndefined();
    expect(where.availableUntil).toBeUndefined();
    // `availableProductWhere` exprime la fenêtre par un `OR` : sa présence
    // trahirait une contamination par le filtre public.
    expect(where.OR).toBeUndefined();
  });

  it('masque les produits retirés du catalogue', async () => {
    const { service, findMany } = build();
    await service.findAllForOwner('fb-owner');

    expect(whereOf(findMany).deletedAt).toBeNull();
  });

  it("masque le produit fantôme d'un menu PLAT_SPECIAL", async () => {
    const { service, findMany } = build();
    await service.findAllForOwner('fb-owner');

    expect(whereOf(findMany).menus).toEqual({
      none: { menu: { type: 'PLAT_SPECIAL' } },
    });
  });

  it('borne la lecture au vendeur résolu, jamais au restaurantId reçu', async () => {
    // Un RESTAURATEUR qui réclamerait le catalogue d'un tiers est arrêté par
    // `resolveTargetRestaurant` — la même autorité que pour les écritures.
    const resolve = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('Seul un administrateur…'));
    const { service, findMany } = build(resolve);

    await expect(
      service.findAllForOwner('fb-autre-vendeur', 'resto-du-voisin'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("transmet le restaurantId de l'ADMIN à l'arbitre de propriété", async () => {
    const { service, resolve, findMany } = build(
      jest.fn().mockResolvedValue({
        id: 'resto-cible',
        vendorType: 'BAKERY',
        onBehalfOf: true,
      }),
    );

    await service.findAllForOwner('fb-admin', 'resto-cible');

    expect(resolve).toHaveBeenCalledWith('fb-admin', 'resto-cible');
    expect(whereOf(findMany).restaurantId).toBe('resto-cible');
  });

  it('pagine et rend le total serveur', async () => {
    const { service, findMany, count } = build();
    count.mockResolvedValue(42);

    const res = await service.findAllForOwner(
      'fb-owner',
      undefined,
      undefined,
      3,
      20,
    );

    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 40, take: 20 });
    expect(res.meta).toEqual({ total: 42, page: 3, limit: 20, totalPages: 3 });
  });

  it('filtre par section quand une section est demandée', async () => {
    const { service, findMany } = build();
    await service.findAllForOwner('fb-owner', undefined, 'cat-1');

    expect(whereOf(findMany).categoryId).toBe('cat-1');
  });
});
