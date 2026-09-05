import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonService } from '../photos-common/photos-common.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import {
  CreateProductImageDto,
  UpdateProductImageDto,
  ReorderProductImagesDto,
} from './dto';

@Injectable()
export class ProductImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: PhotosCommonService,
  ) {}

  /**
   * Route PUBLIQUE. Le filtre de visibilité manquait : les photos des produits
   * d'un vendeur en cours de configuration ou suspendu restaient accessibles à
   * qui connaissait l'identifiant du produit.
   *
   * `VendorPhotosService` applique déjà cette règle depuis août ; les deux
   * autres galeries — celle-ci et `MenuImagesService` — l'avaient oubliée.
   */
  async list(productId: string) {
    if (!productId) {
      throw new BadRequestException('productId requis');
    }
    const visible = await this.prisma.product.findFirst({
      where: { id: productId, restaurant: PUBLIC_VENDOR_WHERE },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('Produit introuvable');

    return this.prisma.productImage.findMany({
      where: { productId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Galerie vue par son vendeur ou un administrateur, **sans** frontière de
   * visibilité — pendant qu'il remplit sa boutique, le vendeur doit voir les
   * images qu'il vient d'ajouter alors qu'elle n'est pas encore publiée.
   *
   * Elle existe pour la même raison que `GET /products/manage` : le
   * back-office lisait la route publique, qui répond 404 dès que le vendeur
   * est suspendu ou en configuration. L'écran qui porte le bouton « ajouter »
   * affichait donc une galerie vide, et la photo tout juste ajoutée
   * disparaissait au rafraîchissement suivant.
   */
  async listForOwner(productId: string, user: { id: string; role: string }) {
    if (!productId) {
      throw new BadRequestException('productId requis');
    }
    await this.assertProductOwnership(productId, user);
    return this.prisma.productImage.findMany({
      where: { productId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Remonte au restaurant parent puis délègue à PhotosCommonService.
   * Si productId invalide → NotFound.
   */
  private async assertProductOwnership(
    productId: string,
    user: { id: string; role: string },
  ): Promise<string> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { restaurantId: true },
    });
    if (!product) throw new NotFoundException('Produit introuvable');
    await this.common.assertRestaurantOwnership(product.restaurantId, user);
    return product.restaurantId;
  }

  async create(dto: CreateProductImageDto, user: { id: string; role: string }) {
    await this.assertProductOwnership(dto.productId, user);
    await this.common.assertUnderMax('productImage', {
      productId: dto.productId,
    });

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover) {
        await this.common.demoteOtherCovers(
          'productImage',
          { productId: dto.productId },
          null,
          tx,
        );
      }
      const image = await tx.productImage.create({
        data: {
          productId: dto.productId,
          url: dto.url,
          publicId: dto.publicId ?? null,
          alt: dto.alt ?? null,
          isCover: dto.isCover ?? false,
        },
      });
      // Rétrocompat : la couverture pilote Product.imageUrl (lu par les cartes).
      if (image.isCover) {
        await tx.product.update({
          where: { id: dto.productId },
          data: { imageUrl: image.url },
        });
      }
      return image;
    });
  }

  async update(
    id: string,
    dto: UpdateProductImageDto,
    user: { id: string; role: string },
  ) {
    const image = await this.prisma.productImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertProductOwnership(image.productId, user);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover === true) {
        await this.common.demoteOtherCovers(
          'productImage',
          { productId: image.productId },
          id,
          tx,
        );
      }
      const updated = await tx.productImage.update({
        where: { id },
        data: {
          ...(dto.alt !== undefined && { alt: dto.alt }),
          ...(dto.displayOrder !== undefined && {
            displayOrder: dto.displayOrder,
          }),
          ...(dto.isCover !== undefined && { isCover: dto.isCover }),
        },
      });
      if (dto.isCover === true) {
        await tx.product.update({
          where: { id: image.productId },
          data: { imageUrl: updated.url },
        });
      }
      return updated;
    });
  }

  async remove(id: string, user: { id: string; role: string }) {
    const image = await this.prisma.productImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertProductOwnership(image.productId, user);

    await this.prisma.$transaction(async (tx) => {
      await tx.productImage.delete({ where: { id } });
      if (image.isCover) {
        // Repromotion : la première image restante (ordre d'affichage) devient
        // la nouvelle couverture et pilote Product.imageUrl.
        const next = await tx.productImage.findFirst({
          where: { productId: image.productId },
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        });
        if (next) {
          await tx.productImage.update({
            where: { id: next.id },
            data: { isCover: true },
          });
          await tx.product.update({
            where: { id: image.productId },
            data: { imageUrl: next.url },
          });
        } else {
          await tx.product.update({
            where: { id: image.productId },
            data: { imageUrl: null },
          });
        }
      }
    });
    await this.common.cleanupCloudinary(image.publicId);
    return { success: true };
  }

  async reorder(
    dto: ReorderProductImagesDto,
    user: { id: string; role: string },
  ) {
    await this.assertProductOwnership(dto.productId, user);

    const images = await this.prisma.productImage.findMany({
      where: { id: { in: dto.ids } },
      select: { id: true, productId: true },
    });
    if (images.length !== dto.ids.length) {
      throw new BadRequestException('Certaines images sont introuvables');
    }
    const wrongOwner = images.find((p) => p.productId !== dto.productId);
    if (wrongOwner) {
      throw new BadRequestException(
        "Certaines images n'appartiennent pas au produit cible",
      );
    }

    return this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.productImage.update({
          where: { id },
          data: { displayOrder: index },
        }),
      ),
    );
  }
}
