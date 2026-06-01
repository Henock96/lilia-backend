import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PhotosCommonService } from '../photos-common/photos-common.service';
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

  async list(productId: string) {
    if (!productId) {
      throw new BadRequestException('productId requis');
    }
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
    await this.common.assertUnderMax('productImage', { productId: dto.productId });

    return this.prisma.$transaction(async (tx) => {
      if (dto.isCover) {
        await this.common.demoteOtherCovers(
          'productImage',
          { productId: dto.productId },
          null,
          tx,
        );
      }
      return tx.productImage.create({
        data: {
          productId: dto.productId,
          url: dto.url,
          publicId: dto.publicId ?? null,
          alt: dto.alt ?? null,
          isCover: dto.isCover ?? false,
        },
      });
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
      return tx.productImage.update({
        where: { id },
        data: {
          ...(dto.alt !== undefined && { alt: dto.alt }),
          ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
          ...(dto.isCover !== undefined && { isCover: dto.isCover }),
        },
      });
    });
  }

  async remove(id: string, user: { id: string; role: string }) {
    const image = await this.prisma.productImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image introuvable');
    await this.assertProductOwnership(image.productId, user);

    await this.prisma.productImage.delete({ where: { id } });
    await this.common.cleanupCloudinary(image.publicId);
    return { success: true };
  }

  async reorder(dto: ReorderProductImagesDto, user: { id: string; role: string }) {
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
        'Certaines images n\'appartiennent pas au produit cible',
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
