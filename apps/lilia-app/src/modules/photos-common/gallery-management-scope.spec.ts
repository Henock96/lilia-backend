import { BadRequestException } from '@nestjs/common';

import { VendorPhotosService } from '../vendor-photos/vendor-photos.service';
import { ProductImagesService } from '../product-images/product-images.service';
import { MenuImagesService } from '../menu-images/menu-images.service';
import { PhotosCommonService } from './photos-common.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';

/**
 * « Qu'y a-t-il à voir ? » et « qu'ai-je à gérer ? » sont deux questions
 * différentes — pour les galeries comme pour le catalogue.
 *
 * Les trois back-offices lisaient la route **publique** (`GET /vendor-photos`,
 * `/product-images`, `/menu-images`). Cette route applique
 * `PUBLIC_VENDOR_WHERE`, donc ne rend rien d'un vendeur suspendu, non validé
 * ou en cours de configuration : `[]` côté vendeur, `404` côté produit et
 * menu. L'écran d'administration affichait donc « Aucune photo » sur des
 * galeries **peuplées en base** (constaté en production : deux vendeurs
 * suspendus, trois photos), et la photo qu'on venait d'ajouter disparaissait
 * au rafraîchissement — invalidation de cache suivie d'un relecture publique
 * qui ne la voit pas.
 *
 * La propriété vérifiée ici est celle qui manquait : **la lecture de gestion
 * ne consulte jamais la frontière de visibilité, elle consulte la propriété.**
 */
describe('Galeries — la vue de gestion ignore la frontière publique', () => {
  const photos = [{ id: 'p_1' }, { id: 'p_2' }];

  /** Vendeur suspendu : présent en base, absent du marketplace. */
  const suspendedVendorId = 'r_suspended';
  const admin = { id: 'u_admin', role: 'ADMIN' };

  function makePrisma() {
    return {
      restaurant: { findFirst: jest.fn().mockResolvedValue(null) },
      product: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
      },
      menuDuJour: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
      },
      vendorPhoto: { findMany: jest.fn().mockResolvedValue(photos) },
      productImage: { findMany: jest.fn().mockResolvedValue(photos) },
      menuImage: { findMany: jest.fn().mockResolvedValue(photos) },
    };
  }

  /** ADMIN passe sans lecture : la propriété est tranchée sur le rôle. */
  const common = {
    assertRestaurantOwnership: jest.fn().mockResolvedValue(undefined),
  } as unknown as PhotosCommonService;

  beforeEach(() => jest.clearAllMocks());

  describe('vendeur', () => {
    it('la route publique rend une liste VIDE sur un vendeur non publié', async () => {
      const prisma = makePrisma();
      const service = new VendorPhotosService(
        prisma as unknown as PrismaService,
        common,
      );

      await expect(service.list(suspendedVendorId)).resolves.toEqual([]);
      expect(prisma.restaurant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining(PUBLIC_VENDOR_WHERE),
        }),
      );
      expect(prisma.vendorPhoto.findMany).not.toHaveBeenCalled();
    });

    it('la route de gestion rend les photos du MÊME vendeur', async () => {
      const prisma = makePrisma();
      const service = new VendorPhotosService(
        prisma as unknown as PrismaService,
        common,
      );

      await expect(
        service.listForOwner(suspendedVendorId, admin),
      ).resolves.toEqual(photos);
      // Aucune consultation de la frontière de visibilité sur ce chemin.
      expect(prisma.restaurant.findFirst).not.toHaveBeenCalled();
      expect(common.assertRestaurantOwnership).toHaveBeenCalledWith(
        suspendedVendorId,
        admin,
      );
    });

    it('refuse un identifiant vide plutôt que de lister toute la base', async () => {
      const prisma = makePrisma();
      const service = new VendorPhotosService(
        prisma as unknown as PrismaService,
        common,
      );
      await expect(service.listForOwner('', admin)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('produit', () => {
    it('la route publique refuse le produit d’un vendeur non publié', async () => {
      const prisma = makePrisma();
      const service = new ProductImagesService(
        prisma as unknown as PrismaService,
        common,
        { emit: jest.fn() } as never,
      );
      await expect(service.list('prod_1')).rejects.toThrow(
        'Produit introuvable',
      );
    });

    it('la route de gestion rend ses images', async () => {
      const prisma = makePrisma();
      prisma.product.findUnique.mockResolvedValue({
        restaurantId: suspendedVendorId,
      });
      const service = new ProductImagesService(
        prisma as unknown as PrismaService,
        common,
        { emit: jest.fn() } as never,
      );

      await expect(service.listForOwner('prod_1', admin)).resolves.toEqual(
        photos,
      );
      expect(prisma.product.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('menu', () => {
    it('la route publique refuse le menu d’un vendeur non publié', async () => {
      const prisma = makePrisma();
      const service = new MenuImagesService(
        prisma as unknown as PrismaService,
        common,
      );
      await expect(service.list('menu_1')).rejects.toThrow('Menu introuvable');
    });

    it('la route de gestion rend ses images', async () => {
      const prisma = makePrisma();
      prisma.menuDuJour.findUnique.mockResolvedValue({
        restaurantId: suspendedVendorId,
      });
      const service = new MenuImagesService(
        prisma as unknown as PrismaService,
        common,
      );

      await expect(service.listForOwner('menu_1', admin)).resolves.toEqual(
        photos,
      );
      expect(prisma.menuDuJour.findFirst).not.toHaveBeenCalled();
    });
  });
});

/**
 * « Au plus un cover » était garanti ; « au moins un cover tant qu'il reste une
 * photo » ne l'était pas. Supprimer la principale laissait la galerie sans
 * étoile et repassait la case « photo de couverture » de la checklist vendeur
 * en défaut, sans qu'aucun geste ne l'ait demandé.
 */
describe('PhotosCommonService.promoteNextCover', () => {
  function makeService(rows: { findFirst: jest.Mock; update: jest.Mock }) {
    const prisma = { vendorPhoto: rows };
    return {
      service: new PhotosCommonService(
        prisma as unknown as PrismaService,
        { deleteImage: jest.fn() } as never,
      ),
      rows,
    };
  }

  it('promeut la première photo restante quand le cover a disparu', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null) // plus aucun cover
      .mockResolvedValueOnce({ id: 'p_2' }); // première restante
    const update = jest.fn();
    const { service } = makeService({ findFirst, update });

    await service.promoteNextCover('vendorPhoto', { restaurantId: 'r_1' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'p_2' },
      data: { isCover: true },
    });
  });

  it('ne touche à rien si un cover subsiste', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'p_1' });
    const update = jest.fn();
    const { service } = makeService({ findFirst, update });

    await service.promoteNextCover('vendorPhoto', { restaurantId: 'r_1' });

    expect(update).not.toHaveBeenCalled();
  });

  it('ne touche à rien sur une galerie devenue vide', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const update = jest.fn();
    const { service } = makeService({ findFirst, update });

    await service.promoteNextCover('vendorPhoto', { restaurantId: 'r_1' });

    expect(update).not.toHaveBeenCalled();
  });
});
